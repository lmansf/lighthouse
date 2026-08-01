import type { DataSource, FileNode } from "../types";
import type { PlatformKind } from "../services";

/**
 * The narrow HTTP boundary used by the real RAG contract implementation.
 *
 * Domain services map operations to request bodies.
 * This transport owns endpoint, headers, JSON decoding, and HTTP failures.
 */
export interface RagHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type RagFetch = (input: string, init?: RequestInit) => Promise<RagHttpResponse>;

export interface RagTreeResponse {
  sources: DataSource[];
  nodes: FileNode[];
  desktop: boolean;
  platform?: PlatformKind;
}

export interface RagPostResult<T extends Record<string, unknown>> {
  ok: boolean;
  status: number;
  body: T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class RagTransport {
  private readonly request: RagFetch;

  // The default MUST resolve `fetch` at CALL time rather than capture it here.
  // This module is evaluated — and the `ragTransport` singleton below
  // constructed — during import, which is strictly before Providers installs
  // the Tauri IPC interceptor that patches window.fetch. A captured reference
  // stays the unpatched native fetch forever, so /api/rag goes to the asset
  // origin and 404s: the whole vault tree fails to load in the shell (the
  // 0.14.18 regression, roadmap §57). Calling through this wrapper also keeps
  // the receiver global — an unbound native fetch throws "Illegal invocation"
  // in a browser, though Node's undici tolerates it, which is why the suite
  // never caught it. Pinned by test/ragTransport.fetch.test.mjs.
  constructor(request: RagFetch = (input, init) => fetch(input, init)) {
    this.request = request;
  }

  async getTree(): Promise<RagTreeResponse> {
    const response = await this.request("/api/rag", { cache: "no-store" });
    if (!response.ok) throw new Error(`GET /api/rag ${response.status}`);
    const body = asRecord(await response.json().catch(() => ({})));
    return {
      sources: Array.isArray(body.sources) ? (body.sources as DataSource[]) : [],
      nodes: Array.isArray(body.nodes) ? (body.nodes as FileNode[]) : [],
      desktop: body.desktop === true,
      ...(body.platform === "desktop" || body.platform === "ios" || body.platform === "android"
        ? { platform: body.platform }
        : {}),
    };
  }

  async post<T extends Record<string, unknown> = Record<string, unknown>>(
    body: unknown,
  ): Promise<T> {
    const result = await this.postResult<T>(body);
    if (!result.ok) throw new Error(`POST /api/rag ${result.status}`);
    return result.body;
  }

  async postResult<T extends Record<string, unknown> = Record<string, unknown>>(
    body: unknown,
  ): Promise<RagPostResult<T>> {
    const response = await this.request("/api/rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      ok: response.ok,
      status: response.status,
      body: asRecord(await response.json().catch(() => ({}))) as T,
    };
  }
}

export const ragTransport = new RagTransport();
