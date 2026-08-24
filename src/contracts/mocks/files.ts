import type { Attachment } from "../types";

/**
 * Seed attachments for the mock engine (`npm run dev` with the mock service):
 * a small conversation corpus that exercises the shapes the UI branches on —
 * a spreadsheet (tabular ⇒ analytics, recipes, suggested asks), a PDF
 * (OCR-relevant ⇒ the inspector's availability line), and prose.
 *
 * Until 0.15.0 this file seeded a vault TREE — three DataSources and a nested
 * FileNode hierarchy with per-file `ragIncluded` flags. There is no tree to
 * seed any more: a conversation holds up to ten attachments, and attaching one
 * is the whole decision (openspec: refocus-chat-attachments).
 */
export const SEED_ATTACHMENTS: Attachment[] = [
  {
    id: "att-000000000001",
    name: "Q3 sales.csv",
    hash: "0".repeat(64),
    size: 18_400,
    addedMs: 0,
  },
  {
    id: "att-000000000002",
    name: "Employee handbook.pdf",
    hash: "1".repeat(64),
    size: 402_110,
    addedMs: 0,
  },
  {
    id: "att-000000000003",
    name: "Roadmap notes.md",
    hash: "2".repeat(64),
    size: 4_820,
    addedMs: 0,
  },
];
