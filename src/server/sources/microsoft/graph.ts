/**
 * Microsoft Graph client for the SharePoint connector — just the calls we need:
 * enumerate the user's OneDrive + followed SharePoint document libraries as a
 * names-only tree, and download a single item's bytes when the user enables it.
 *
 * Listing is deliberately bounded (depth + total node cap) so a large tenant
 * can't produce a gigantic tree or a slow first paint; what's dropped is logged.
 */
import fs from "node:fs";
import { SHAREPOINT_SOURCE_ID } from "../../config";
import { getAccessToken, type SpNode } from "./auth";

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Safety bounds on the placeholder listing. */
const MAX_NODES = 1500;
const MAX_DEPTH = 6;
const MAX_DRIVES = 12;

const nodeId = (driveId: string, itemId: string) => `${SHAREPOINT_SOURCE_ID}::${driveId}::${itemId}`;

async function graphGet(pathOrUrl: string): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`graph ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

interface DriveRef {
  driveId: string;
  /** Display label for this library's root node. */
  label: string;
}

/** The drives to scan: the user's OneDrive plus each followed site's libraries. */
async function listDrives(): Promise<DriveRef[]> {
  const drives: DriveRef[] = [];
  try {
    const me = await graphGet("/me/drive");
    drives.push({ driveId: String(me.id), label: "OneDrive" });
  } catch {
    // user may have no personal drive; continue with sites
  }
  try {
    const followed = await graphGet("/me/followedSites");
    const sites = (followed.value as Array<Record<string, unknown>>) ?? [];
    for (const site of sites) {
      if (drives.length >= MAX_DRIVES) break;
      try {
        const libs = await graphGet(`/sites/${site.id}/drives`);
        for (const d of (libs.value as Array<Record<string, unknown>>) ?? []) {
          if (drives.length >= MAX_DRIVES) break;
          const siteName = String(site.displayName || site.name || "Site");
          const driveName = String(d.name || "Documents");
          drives.push({ driveId: String(d.id), label: `${siteName} / ${driveName}` });
        }
      } catch {
        // skip a site we can't read
      }
    }
  } catch {
    // followedSites unavailable (e.g. personal account) — OneDrive only
  }
  return drives;
}

function toNode(driveId: string, item: Record<string, unknown>, parentId: string | null): SpNode {
  const isFolder = Boolean(item.folder);
  const file = item.file as Record<string, unknown> | undefined;
  return {
    id: nodeId(driveId, String(item.id)),
    name: String(item.name),
    parentId,
    driveId,
    itemId: String(item.id),
    kind: isFolder ? "folder" : "file",
    mimeType: file ? String(file.mimeType || "") || undefined : undefined,
    size: typeof item.size === "number" ? item.size : undefined,
    webUrl: item.webUrl ? String(item.webUrl) : undefined,
  };
}

/**
 * Build the placeholder tree across all scannable drives. Folders are walked
 * breadth-first up to MAX_DEPTH / MAX_NODES; nothing is downloaded here.
 */
export async function listTree(): Promise<SpNode[]> {
  const out: SpNode[] = [];
  const drives = await listDrives();
  let truncated = false;

  for (const { driveId, label } of drives) {
    if (out.length >= MAX_NODES) {
      truncated = true;
      break;
    }
    let root: Record<string, unknown>;
    try {
      root = await graphGet(`/drives/${driveId}/root`);
    } catch {
      continue;
    }
    // Top-level node for the library, renamed to a friendly label.
    const rootNode = toNode(driveId, root, null);
    rootNode.name = label;
    rootNode.kind = "folder";
    out.push(rootNode);

    // BFS the folder tree.
    let frontier: Array<{ itemId: string; id: string; depth: number }> = [
      { itemId: rootNode.itemId, id: rootNode.id, depth: 0 },
    ];
    while (frontier.length && out.length < MAX_NODES) {
      const next: typeof frontier = [];
      for (const f of frontier) {
        if (f.depth >= MAX_DEPTH || out.length >= MAX_NODES) {
          if (out.length >= MAX_NODES) truncated = true;
          break;
        }
        let url: string | null = `/drives/${driveId}/items/${f.itemId}/children?$top=200`;
        while (url && out.length < MAX_NODES) {
          let page: Record<string, unknown>;
          try {
            page = await graphGet(url);
          } catch {
            break;
          }
          for (const item of (page.value as Array<Record<string, unknown>>) ?? []) {
            if (out.length >= MAX_NODES) {
              truncated = true;
              break;
            }
            const node = toNode(driveId, item, f.id);
            out.push(node);
            if (node.kind === "folder") {
              next.push({ itemId: node.itemId, id: node.id, depth: f.depth + 1 });
            }
          }
          url = page["@odata.nextLink"] ? String(page["@odata.nextLink"]) : null;
        }
      }
      frontier = next;
    }
  }

  if (truncated) {
    console.warn(
      `[sharepoint] listing capped at ${MAX_NODES} items / depth ${MAX_DEPTH}; some files are not shown.`,
    );
  }
  return out;
}

/** Download an item's bytes to `destPath`. Returns false if the item has no content. */
export async function downloadItem(driveId: string, itemId: string, destPath: string): Promise<boolean> {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH}/drives/${driveId}/items/${itemId}/content`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    if (res.status === 404) return false;
    throw new Error(`download ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return true;
}
