import type { DataSource, FileNode } from "../types";

/**
 * Seed file tree. Demonstrates the core idea:
 *  - a database source (available) and two folder sources, one of which is
 *    NOT available to RAG;
 *  - mixed per-file `ragIncluded` so the explorer's toggle state is visible
 *    from first render.
 */

export const SEED_SOURCES: DataSource[] = [
  { id: "src-db", name: "Analytics Warehouse", kind: "database", available: true },
  { id: "src-handbook", name: "Company Handbook", kind: "folder", available: true },
  { id: "src-personal", name: "Personal Drafts", kind: "folder", available: false },
];

export const SEED_NODES: FileNode[] = [
  // Database source
  { id: "db-root", parentId: null, sourceId: "src-db", name: "Analytics Warehouse", kind: "database", ragIncluded: true },
  { id: "db-customers", parentId: "db-root", sourceId: "src-db", name: "customers", kind: "file", mimeType: "application/sql", size: 18_400, ragIncluded: true },
  { id: "db-orders", parentId: "db-root", sourceId: "src-db", name: "orders", kind: "file", mimeType: "application/sql", size: 42_900, ragIncluded: true },
  { id: "db-churn", parentId: "db-root", sourceId: "src-db", name: "churn_model_notes", kind: "file", mimeType: "text/markdown", size: 7_100, ragIncluded: false },

  // Company Handbook folder (available)
  { id: "hb-root", parentId: null, sourceId: "src-handbook", name: "Company Handbook", kind: "folder", ragIncluded: true },
  { id: "hb-onboarding", parentId: "hb-root", sourceId: "src-handbook", name: "Onboarding Guide.pdf", kind: "file", mimeType: "application/pdf", size: 1_240_000, ragIncluded: true },
  { id: "hb-benefits", parentId: "hb-root", sourceId: "src-handbook", name: "Benefits 2026.pdf", kind: "file", mimeType: "application/pdf", size: 980_000, ragIncluded: true },
  { id: "hb-security", parentId: "hb-root", sourceId: "src-handbook", name: "Security Policy.docx", kind: "file", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 56_000, ragIncluded: false },

  // Personal Drafts folder (source unavailable -> excluded)
  { id: "pd-root", parentId: null, sourceId: "src-personal", name: "Personal Drafts", kind: "folder", ragIncluded: false },
  { id: "pd-ideas", parentId: "pd-root", sourceId: "src-personal", name: "Half-baked ideas.txt", kind: "file", mimeType: "text/plain", size: 3_200, ragIncluded: false },
  { id: "pd-resume", parentId: "pd-root", sourceId: "src-personal", name: "Resume draft.docx", kind: "file", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 41_000, ragIncluded: false },
];
