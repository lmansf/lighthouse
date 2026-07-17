// Theme-aware SQL syntax highlighter for the "Query used" fence (usability
// patch §1). The engine already pretty-prints the SQL it writes (clause per
// line, one wide column per line — see native/.../sqlfmt.rs); this renders that
// laid-out text with a small hand-rolled tokenizer (src/lib/sqlHighlight.ts).
// No syntax-highlighting dependency: a scan + Beam-token colors, so the "Query
// used" disclosure reads like SQL in a console, in both light and dark.
//
// Display-only: the tokenizer classifies for COLOUR, never rewrites. String and
// quoted-identifier spans are emitted verbatim so nothing inside them is
// recoloured as a keyword.
import * as React from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { tokenizeSqlDisplay, type SqlPiece } from "@/lib/sqlHighlight";

const useStyles = makeStyles({
  keyword: { color: tokens.colorBrandForeground2, fontWeight: tokens.fontWeightSemibold },
  string: { color: tokens.colorPaletteGreenForeground2 },
  number: { color: tokens.colorPaletteBerryForeground2 },
  comment: { color: tokens.colorNeutralForeground3, fontStyle: "italic" },
  punct: { color: tokens.colorNeutralForeground3 },
  ident: { color: tokens.colorNeutralForeground1 },
});

/** Highlighted <code> for a SQL fence. Rendered by AnswerMarkdown's code
 *  override when the fence language is `sql`. */
export const SqlBlock = React.memo(function SqlBlock({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const styles = useStyles();
  const pieces = React.useMemo(() => tokenizeSqlDisplay(code), [code]);
  return (
    <code className={className}>
      {pieces.map((p: SqlPiece, k: number) =>
        p.cls === "ws" ? (
          p.text
        ) : (
          <span key={k} className={styles[p.cls]}>
            {p.text}
          </span>
        ),
      )}
    </code>
  );
});
