//! PDF table reconstruction from the text layer (openspec: add-pdf-tables).
//!
//! `pdf-extract` decodes fonts and hands us every glyph with its decoded
//! unicode AND its position (the text-rendering matrix) via the public
//! `OutputDev` trait. That is the hard part already solved; reconstructing a
//! table is then pure geometry: cluster glyphs into rows by baseline, find the
//! vertical gutters that hold across those rows, and read cells out of the
//! grid. No ML, no cloud, no new dependency.
//!
//! TRUST INVARIANT (shared with charts): a grid is emitted ONLY when the
//! geometry is unambiguous — ≥2 rows, ≥2 columns, and gutters supported across
//! a strong majority of rows. Anything short of that reconstructs nothing and
//! the linear text layer stands. We would rather miss a faint table than
//! assert a wrong one.
//!
//! The geometry (`detect_tables`) is a pure function over `Glyph`s, unit-tested
//! with synthetic layouts so it never depends on a real PDF parser.

/// One positioned glyph in the crate's raw (bottom-left-origin) PDF space — we
/// don't flip, since row/column clustering only needs consistent coordinates.
#[derive(Clone, Debug)]
pub(crate) struct Glyph {
    /// Left edge (text-matrix translation x).
    pub x: f64,
    /// Baseline (text-matrix translation y); larger = higher on the page.
    pub y: f64,
    /// On-page advance width, so `x + w` is the glyph's right edge.
    pub w: f64,
    /// Effective on-page font size; sets the row/gutter tolerances.
    pub fs: f64,
    pub text: String,
}

/// A reconstructed table: a rectangular grid of cell strings. `header_like` is
/// set when the first row reads as column names (all non-empty, none numeric) —
/// the gate the analytics layer uses before trusting it as a SQL schema.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Table {
    pub header_like: bool,
    pub rows: Vec<Vec<String>>,
}

// Geometry constants, in units of the page's median font size. Conservative on
// purpose: a missed table costs us nothing (good linear text remains), a
// mis-parsed one costs the trust invariant.
const CELL_GAP: f64 = 1.1; // gap that separates cells within a row (vs word gaps)
const SPACE_TOL: f64 = 0.28; // gap inside a cell that still means a word space
const ROW_TOL: f64 = 0.6; // baseline delta that still counts as the same row
const GUTTER_SUPPORT: f64 = 0.6; // fraction of rows a gutter must span
const GUTTER_MIN_W: f64 = 0.3; // narrowest accepted gutter band
const FIT_RATIO: f64 = 0.7; // fraction of rows that must fit the column model

const MIN_ROWS: usize = 2;
const MIN_COLS: usize = 2;
const MAX_ROWS: usize = 120; // bound a runaway page; extra rows are dropped
const MAX_COLS: usize = 24;
pub(crate) const MAX_TABLE_PAGES: usize = 40;
const MAX_GLYPHS_PER_PAGE: usize = 80_000;

/// A cell within a single row: its x-span and accumulated text.
struct Cell {
    x0: f64,
    x1: f64,
    text: String,
}

/// Median font size across a page's glyphs — the tolerance yardstick.
fn median_fs(glyphs: &[Glyph]) -> f64 {
    let mut sizes: Vec<f64> = glyphs.iter().map(|g| g.fs).filter(|f| *f > 0.0).collect();
    if sizes.is_empty() {
        return 0.0;
    }
    sizes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    sizes[sizes.len() / 2]
}

/// Group glyphs into visual rows (top to bottom) by baseline proximity.
fn cluster_rows(glyphs: &[Glyph], medfs: f64) -> Vec<Vec<Glyph>> {
    let mut sorted: Vec<Glyph> = glyphs.to_vec();
    // Top to bottom = y descending; ties left to right.
    sorted.sort_by(|a, b| {
        b.y.partial_cmp(&a.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });
    let tol = ROW_TOL * medfs;
    let mut rows: Vec<Vec<Glyph>> = Vec::new();
    for g in sorted {
        match rows.last_mut() {
            Some(row) if (row[0].y - g.y).abs() <= tol => row.push(g),
            _ => rows.push(vec![g]),
        }
    }
    for row in &mut rows {
        row.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
    }
    rows
}

/// Split one row's glyphs into cells at gaps wide enough to be a column break,
/// inserting a space where a smaller gap means a word boundary inside a cell.
fn row_cells(row: &[Glyph], medfs: f64) -> Vec<Cell> {
    let cell_gap = CELL_GAP * medfs;
    let space_gap = SPACE_TOL * medfs;
    let mut cells: Vec<Cell> = Vec::new();
    let mut cur: Option<Cell> = None;
    let mut prev_end = f64::NEG_INFINITY;
    for g in row {
        let gap = g.x - prev_end;
        match cur.as_mut() {
            Some(c) if gap < cell_gap => {
                if gap > space_gap && !c.text.ends_with(' ') {
                    c.text.push(' ');
                }
                c.text.push_str(&g.text);
                c.x1 = g.x + g.w;
            }
            _ => {
                if let Some(c) = cur.take() {
                    cells.push(c);
                }
                cur = Some(Cell { x0: g.x, x1: g.x + g.w, text: g.text.clone() });
            }
        }
        prev_end = g.x + g.w;
    }
    if let Some(c) = cur.take() {
        cells.push(c);
    }
    for c in &mut cells {
        c.text = normalize_ws(&c.text);
    }
    cells.retain(|c| !c.text.is_empty());
    cells
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Find vertical column boundaries: x-positions covered by an inter-cell gap in
/// a strong majority of rows. A sweep over gap intervals gives the coverage
/// count at every x; a maximal band with enough coverage and width is a gutter,
/// and its midpoint is the boundary.
fn column_boundaries(rows: &[Vec<Cell>], medfs: f64) -> Vec<f64> {
    let n = rows.len();
    if n == 0 {
        return Vec::new();
    }
    // Sweep events: +1 at a gap's start, -1 at its end.
    let mut events: Vec<(f64, i32)> = Vec::new();
    for row in rows {
        for pair in row.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            if b.x0 > a.x1 {
                events.push((a.x1, 1));
                events.push((b.x0, -1));
            }
        }
    }
    if events.is_empty() {
        return Vec::new();
    }
    events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let need = (GUTTER_SUPPORT * n as f64).ceil() as i32;
    let min_w = GUTTER_MIN_W * medfs;

    // Coverage is constant between consecutive event x's; record each interval
    // as (lo, hi, cover). Coverage after applying the events at `x` holds until
    // the next distinct x.
    let mut intervals: Vec<(f64, f64, i32)> = Vec::new();
    let mut cover = 0i32;
    let mut i = 0;
    while i < events.len() {
        let x = events[i].0;
        while i < events.len() && events[i].0 == x {
            cover += events[i].1;
            i += 1;
        }
        if i < events.len() {
            intervals.push((x, events[i].0, cover));
        }
    }

    // ONE boundary per MAXIMAL contiguous region with enough coverage — a wide
    // gutter spans several constant-coverage sub-bands but is a single column
    // break, so we merge them before taking the midpoint.
    let mut boundaries: Vec<f64> = Vec::new();
    let mut run: Option<(f64, f64)> = None;
    for (lo, hi, c) in intervals {
        if c >= need {
            run = Some((run.map(|(l, _)| l).unwrap_or(lo), hi));
        } else if let Some((lo0, hi0)) = run.take() {
            if hi0 - lo0 >= min_w {
                boundaries.push((lo0 + hi0) / 2.0);
            }
        }
    }
    if let Some((lo0, hi0)) = run.take() {
        if hi0 - lo0 >= min_w {
            boundaries.push((lo0 + hi0) / 2.0);
        }
    }
    boundaries
}

/// Assign a cell (by its center) to a column index given the boundaries.
fn column_of(cell: &Cell, boundaries: &[f64]) -> usize {
    let center = (cell.x0 + cell.x1) / 2.0;
    boundaries.iter().take_while(|&&b| center >= b).count()
}

/// Reconstruct the confident tables on one page's glyphs. Returns empty when
/// the geometry is ambiguous (fail closed).
pub(crate) fn detect_tables(glyphs: &[Glyph]) -> Vec<Table> {
    if glyphs.is_empty() || glyphs.len() > MAX_GLYPHS_PER_PAGE {
        return Vec::new();
    }
    let medfs = median_fs(glyphs);
    if medfs <= 0.0 {
        return Vec::new();
    }
    let grouped = cluster_rows(glyphs, medfs);
    let rows: Vec<Vec<Cell>> = grouped.iter().map(|r| row_cells(r, medfs)).collect();
    let rows: Vec<Vec<Cell>> = rows.into_iter().filter(|r| !r.is_empty()).collect();
    if rows.len() < MIN_ROWS {
        return Vec::new();
    }

    let boundaries = column_boundaries(&rows, medfs);
    let ncols = boundaries.len() + 1;
    if !(MIN_COLS..=MAX_COLS).contains(&ncols) {
        return Vec::new();
    }

    // Fit every row into the column model; a row is clean when each column it
    // touches gets exactly one cell (no two cells collapse into one column).
    let mut clean = 0usize;
    let mut grid: Vec<Vec<String>> = Vec::new();
    for row in &rows {
        let mut cells: Vec<String> = vec![String::new(); ncols];
        let mut collision = false;
        for c in row {
            let col = column_of(c, &boundaries).min(ncols - 1);
            if cells[col].is_empty() {
                cells[col] = c.text.clone();
            } else {
                cells[col].push(' ');
                cells[col].push_str(&c.text);
                collision = true;
            }
        }
        if !collision && row.len() >= 2 {
            clean += 1;
        }
        grid.push(cells);
    }

    let fit = clean as f64 / rows.len() as f64;
    if fit < FIT_RATIO {
        return Vec::new();
    }
    // A grid every one of whose data rows is single-column-ish isn't a table.
    if grid.iter().all(|r| r.iter().filter(|c| !c.is_empty()).count() < 2) {
        return Vec::new();
    }

    if grid.len() > MAX_ROWS {
        grid.truncate(MAX_ROWS);
    }
    let header_like = grid.first().is_some_and(|h| {
        h.iter().all(|c| !c.is_empty()) && h.iter().all(|c| !is_numeric_cell(c))
    });
    vec![Table { header_like, rows: grid }]
}

/// A cell reads as a number after stripping the usual accounting dressing
/// (currency, thousands separators, percent, parenthesised negatives).
pub(crate) fn is_numeric_cell(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    let cleaned: String = t
        .trim_start_matches(['$', '£', '€', '¥'])
        .replace([',', '%', '(', ')', ' '], "");
    let cleaned = cleaned.trim_start_matches('-');
    !cleaned.is_empty() && cleaned.parse::<f64>().is_ok()
}

/// Render reconstructed tables as GitHub-flavored markdown. Cells are escaped so
/// a pipe or newline in the source can't break the grid.
pub(crate) fn tables_to_markdown(tables: &[Table]) -> String {
    let mut out = String::new();
    for (i, t) in tables.iter().enumerate() {
        if t.rows.is_empty() {
            continue;
        }
        if i > 0 {
            out.push('\n');
        }
        let ncols = t.rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let render_row = |cells: &[String]| -> String {
            let mut padded: Vec<String> = (0..ncols)
                .map(|c| escape_cell(cells.get(c).map(String::as_str).unwrap_or("")))
                .collect();
            // Guarantee at least a space so the pipe columns stay aligned.
            for c in &mut padded {
                if c.is_empty() {
                    *c = " ".into();
                }
            }
            format!("| {} |", padded.join(" | "))
        };
        out.push_str(&render_row(&t.rows[0]));
        out.push('\n');
        out.push_str(&format!("| {} |\n", vec!["---"; ncols].join(" | ")));
        for row in &t.rows[1..] {
            out.push_str(&render_row(row));
            out.push('\n');
        }
    }
    out
}

fn escape_cell(s: &str) -> String {
    s.replace('\\', "\\\\").replace('|', "\\|").replace(['\n', '\r'], " ")
}

// --- PDF driving: collect positioned glyphs via pdf-extract's OutputDev ---

/// Collects positioned glyphs per page. We read the text-matrix fields directly
/// (euclid `Transform2D` exposes m11..m32) so no extra dependency is needed, and
/// we keep the crate's raw coordinates — clustering is translation/scale-stable.
struct GridCollector {
    pages: Vec<Vec<Glyph>>,
    over_budget: bool,
}

impl GridCollector {
    fn new() -> Self {
        GridCollector { pages: Vec::new(), over_budget: false }
    }
}

impl pdf_extract::OutputDev for GridCollector {
    fn begin_page(
        &mut self,
        _page_num: u32,
        _media_box: &pdf_extract::MediaBox,
        _art_box: Option<(f64, f64, f64, f64)>,
    ) -> Result<(), pdf_extract::OutputError> {
        if self.pages.len() >= MAX_TABLE_PAGES {
            self.over_budget = true;
        } else {
            self.pages.push(Vec::new());
        }
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), pdf_extract::OutputError> {
        Ok(())
    }

    fn output_character(
        &mut self,
        trm: &pdf_extract::Transform,
        width: f64,
        _spacing: f64,
        font_size: f64,
        char: &str,
    ) -> Result<(), pdf_extract::OutputError> {
        if self.over_budget {
            return Ok(());
        }
        let Some(page) = self.pages.last_mut() else {
            return Ok(());
        };
        // Whitespace-only glyphs are recovered from x-gaps; skipping them avoids
        // double spaces and keeps the per-page budget for real text.
        if char.trim().is_empty() || page.len() >= MAX_GLYPHS_PER_PAGE {
            return Ok(());
        }
        // Effective on-page font size (mirrors PlainTextOutput's own formula,
        // computed straight from the matrix so we don't pull in euclid's ops).
        let vx = font_size * (trm.m11 + trm.m21);
        let vy = font_size * (trm.m12 + trm.m22);
        let fs = (vx.abs() * vy.abs()).sqrt().max(1e-3);
        page.push(Glyph {
            x: trm.m31,
            y: trm.m32,
            w: width * fs,
            fs,
            text: char.to_string(),
        });
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), pdf_extract::OutputError> {
        Ok(())
    }
    fn end_word(&mut self) -> Result<(), pdf_extract::OutputError> {
        Ok(())
    }
    fn end_line(&mut self) -> Result<(), pdf_extract::OutputError> {
        Ok(())
    }
}

/// Collect positioned glyphs page by page. Panic-guarded like `extract_pdf` —
/// pdf-extract can panic on malformed input, and a table pass must never be the
/// thing that breaks a vault scan.
fn collect_pages(buf: &[u8]) -> Vec<Vec<Glyph>> {
    let mut dev = GridCollector::new();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if let Ok(doc) = lopdf::Document::load_mem(buf) {
            let _ = pdf_extract::output_doc(&doc, &mut dev);
        }
    }));
    dev.pages
}

/// All confident tables across a PDF, page by page. Empty when nothing
/// reconstructs cleanly (the linear text layer already carries the content).
pub(crate) fn extract_tables(buf: &[u8]) -> Vec<Table> {
    collect_pages(buf).iter().flat_map(|p| detect_tables(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(x: f64, y: f64, w: f64, text: &str) -> Glyph {
        Glyph { x, y, w, fs: 10.0, text: text.into() }
    }

    /// A clean 3-column revenue grid: header + two data rows.
    fn revenue_grid() -> Vec<Glyph> {
        vec![
            // header row (y=700)
            g(100.0, 700.0, 40.0, "Region"),
            g(250.0, 700.0, 20.0, "Q2"),
            g(350.0, 700.0, 20.0, "Q3"),
            // NE
            g(100.0, 680.0, 18.0, "NE"),
            g(250.0, 680.0, 24.0, "120"),
            g(350.0, 680.0, 24.0, "150"),
            // SE
            g(100.0, 660.0, 18.0, "SE"),
            g(250.0, 660.0, 24.0, "300"),
            g(350.0, 660.0, 24.0, "480"),
        ]
    }

    #[test]
    fn clean_grid_is_reconstructed() {
        let tables = detect_tables(&revenue_grid());
        assert_eq!(tables.len(), 1);
        let t = &tables[0];
        assert!(t.header_like, "all-text first row is a header");
        assert_eq!(t.rows.len(), 3);
        assert_eq!(t.rows[0], vec!["Region", "Q2", "Q3"]);
        assert_eq!(t.rows[1], vec!["NE", "120", "150"]);
        assert_eq!(t.rows[2], vec!["SE", "300", "480"]);
    }

    #[test]
    fn right_aligned_numbers_still_align() {
        // Numbers right-aligned: their x-starts differ per row, but the gutter
        // (empty band) is stable, so the gutter-sweep keeps them one column.
        let glyphs = vec![
            g(100.0, 700.0, 40.0, "Region"),
            g(300.0, 700.0, 20.0, "Amount"),
            g(100.0, 680.0, 18.0, "NE"),
            g(360.0, 680.0, 12.0, "9"), // short number, right side
            g(100.0, 660.0, 18.0, "SE"),
            g(320.0, 660.0, 52.0, "12,500"), // long number, same right edge-ish
        ];
        let tables = detect_tables(&glyphs);
        assert_eq!(tables.len(), 1, "one 2-col table despite ragged number starts");
        assert_eq!(tables[0].rows[1], vec!["NE", "9"]);
        assert_eq!(tables[0].rows[2], vec!["SE", "12,500"]);
    }

    #[test]
    fn multiword_cells_keep_their_spaces() {
        let glyphs = vec![
            g(100.0, 700.0, 40.0, "Region"),
            g(250.0, 700.0, 30.0, "Total"),
            // "North East" as two glyphs with a word-sized gap → one cell.
            g(100.0, 680.0, 44.0, "North"),
            g(148.0, 680.0, 30.0, "East"),
            g(250.0, 680.0, 24.0, "150"),
        ];
        let t = &detect_tables(&glyphs)[0];
        assert_eq!(t.rows[1][0], "North East");
        assert_eq!(t.rows[1][1], "150");
    }

    #[test]
    fn ragged_prose_is_rejected() {
        // A paragraph: one long run per line, no consistent gutters.
        let glyphs = vec![
            g(100.0, 700.0, 300.0, "the quick brown fox jumps over"),
            g(100.0, 686.0, 280.0, "the lazy dog and then keeps going"),
            g(100.0, 672.0, 260.0, "for several more lines of prose here"),
        ];
        assert!(detect_tables(&glyphs).is_empty(), "prose is not a table");
    }

    #[test]
    fn single_column_list_is_rejected() {
        let glyphs = vec![
            g(100.0, 700.0, 40.0, "Apples"),
            g(100.0, 680.0, 44.0, "Oranges"),
            g(100.0, 660.0, 40.0, "Pears"),
        ];
        assert!(detect_tables(&glyphs).is_empty(), "one column is not a table");
    }

    #[test]
    fn numeric_first_row_is_not_a_header() {
        let glyphs = vec![
            g(100.0, 700.0, 18.0, "10"),
            g(250.0, 700.0, 24.0, "120"),
            g(100.0, 680.0, 18.0, "20"),
            g(250.0, 680.0, 24.0, "300"),
        ];
        let t = &detect_tables(&glyphs)[0];
        assert!(!t.header_like, "an all-numeric first row is data, not a header");
    }

    #[test]
    fn is_numeric_cell_reads_accounting_dressing() {
        assert!(is_numeric_cell("1,250"));
        assert!(is_numeric_cell("$1,250.50"));
        assert!(is_numeric_cell("12.5%"));
        assert!(is_numeric_cell("(300)"));
        assert!(!is_numeric_cell("Region"));
        assert!(!is_numeric_cell(""));
        assert!(!is_numeric_cell("Q3 2024"));
    }

    #[test]
    fn markdown_escapes_and_shapes() {
        let t = Table {
            header_like: true,
            rows: vec![
                vec!["a|b".into(), "c".into()],
                vec!["d".into(), "".into()],
            ],
        };
        let md = tables_to_markdown(&[t]);
        assert!(md.contains(r"a\|b"), "pipe in a cell is escaped");
        assert!(md.contains("| --- | --- |"), "has a GFM separator row");
        // Missing cell renders as a padded blank, not a broken row.
        assert!(md.lines().all(|l| l.starts_with("| ") && l.ends_with(" |")));
    }
}
