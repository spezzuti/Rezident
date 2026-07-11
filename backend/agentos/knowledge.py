"""RAG knowledge bases: index a doc folder into a zero-dependency vector store
and retrieve relevant chunks at run time.

Mirrors memory_import.py's scan -> poll -> status shape (a background task moves a
row through indexing -> ready|error) and homes._walk's read-only, .git-excluded,
size-capped corpus walk. The vector store is brute-force cosine over packed
float32 BLOBs (NOT sqlite-vec — a C extension a frozen Windows build may fail to
load): every chunk stores its embedding bytes plus a precomputed L2 norm, so a
query embeds once and scores candidates in Python. At a few-thousand-chunk scale
this is single-digit-ms and adds no native dependency.

Two hard rules, because both run where a raised exception would be damaging:
  * _index (a background task) NEVER raises out — a dead embed endpoint or an
    unreadable tree degrades the KB to status=error and the app stays up.
  * search() NEVER raises into its caller (the runner) — any failure returns [].

Indexing reads the operator's `source_dir` IN PLACE and never writes to it. Each
KB also gets a managed scratch dir under the data dir (mirrors homes.home_dir);
delete_base removes that dir and the DB rows — the operator's documents are never
touched.
"""

import array
import asyncio
import hashlib
import json
import logging
import math
import shutil
import uuid
from pathlib import Path

from .config import settings
from .db import db
from .events import utcnow
from .integrations import IntegrationError, dispatch_embeddings

log = logging.getLogger(__name__)

CONFIG_KEY = "knowledge:config"
DEFAULT_CONFIG = {"provider_key": "ollama", "model": "nomic-embed-text", "top_k": 5}

CHUNK_SIZE = 1200      # ~chars per chunk window
CHUNK_OVERLAP = 150    # ~chars shared with the previous window
MAX_FILE_BYTES = 200_000  # per-file UTF-8 read cap (mirrors homes.read_preview)
EMBED_BATCH = 64       # texts per embeddings request


# ---- config (settings key knowledge:config) ----------------------------------

async def get_config() -> dict:
    row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (CONFIG_KEY,))
    cfg = dict(DEFAULT_CONFIG)
    if row:
        try:
            cfg.update(json.loads(row["value"]))
        except (TypeError, ValueError):
            pass
    try:
        cfg["top_k"] = max(1, int(cfg.get("top_k") or DEFAULT_CONFIG["top_k"]))
    except (TypeError, ValueError):
        cfg["top_k"] = DEFAULT_CONFIG["top_k"]
    cfg["provider_key"] = (cfg.get("provider_key") or DEFAULT_CONFIG["provider_key"]).strip()
    cfg["model"] = (cfg.get("model") or DEFAULT_CONFIG["model"]).strip()
    return cfg


async def set_config(*, provider_key: str | None = None, model: str | None = None,
                     top_k: int | None = None) -> dict:
    """Partial update — a None field preserves the stored value."""
    cfg = await get_config()
    if provider_key is not None:
        cfg["provider_key"] = str(provider_key).strip() or DEFAULT_CONFIG["provider_key"]
    if model is not None:
        cfg["model"] = str(model).strip() or DEFAULT_CONFIG["model"]
    if top_k is not None:
        try:
            cfg["top_k"] = max(1, int(top_k))
        except (TypeError, ValueError):
            pass
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (CONFIG_KEY, json.dumps(cfg)),
    )
    return cfg


# ---- chunking + corpus walk (homes._walk pattern, in place) ------------------

def chunk_text(text: str) -> list[str]:
    """Sliding ~CHUNK_SIZE windows with ~CHUNK_OVERLAP overlap. Empty/blank input
    -> []. Blank windows are dropped so trailing whitespace never yields a chunk."""
    text = (text or "").strip()
    if not text:
        return []
    step = max(1, CHUNK_SIZE - CHUNK_OVERLAP)
    out: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        window = text[start:start + CHUNK_SIZE].strip()
        if window:
            out.append(window)
        if start + CHUNK_SIZE >= n:
            break
        start += step
    return out


def corpus_dir(kb_id: str) -> Path:
    """Managed per-KB scratch dir under the data dir (mirrors homes.home_dir).
    Indexing reads the operator's source_dir IN PLACE; this dir holds only
    Rezident-managed artifacts and is what delete_base removes. The operator's
    actual documents are NEVER touched."""
    return settings.data_dir / "knowledge" / kb_id


def _walk_corpus(source: Path) -> list[tuple[Path, int, float]]:
    """(rel_path, size, mtime) for every regular file under source_dir, .git
    excluded (homes._walk pattern). Unreadable entries are skipped — a stat error
    must never take an index run down."""
    out: list[tuple[Path, int, float]] = []
    if not source.is_dir():
        return out
    for p in source.rglob("*"):
        if ".git" in p.parts:
            continue
        try:
            if p.is_file():
                st = p.stat()
                out.append((p.relative_to(source), st.st_size, st.st_mtime))
        except OSError:
            continue
    return out


def _read_text(path: Path) -> str | None:
    """Capped UTF-8 read (homes.read_preview pattern). Returns None for binaries
    (strict-decode failure) and unreadable files, so they're skipped from the
    corpus rather than embedded as garbage."""
    try:
        raw = path.read_bytes()[:MAX_FILE_BYTES]
    except OSError:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


# ---- embedding pack/unpack (packed float32 + precomputed norm) ----------------

def _pack(vec: list[float]) -> tuple[bytes, int, float]:
    arr = array.array("f", vec)
    norm = math.sqrt(sum(x * x for x in arr))
    return arr.tobytes(), len(arr), norm


def _unpack(blob: bytes) -> array.array:
    arr = array.array("f")
    arr.frombytes(blob)
    return arr


# ---- base CRUD + status ------------------------------------------------------

async def _get_base(kb_id: str) -> dict | None:
    row = await db.fetch_one("SELECT * FROM knowledge_bases WHERE id = ?", (kb_id,))
    return dict(row) if row else None


async def list_bases() -> list[dict]:
    rows = await db.fetch_all("SELECT * FROM knowledge_bases ORDER BY created_at")
    return [dict(r) for r in rows]


async def status(kb_id: str) -> dict | None:
    return await _get_base(kb_id)


async def create_base(name: str, source_dir: str, description: str | None = None) -> dict:
    kb_id = str(uuid.uuid4())
    await db.execute(
        "INSERT INTO knowledge_bases (id, name, description, source_dir) VALUES (?, ?, ?, ?)",
        (kb_id, (name or "").strip(), (description or None), (source_dir or "").strip()),
    )
    try:
        corpus_dir(kb_id).mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return await _get_base(kb_id)


async def delete_base(kb_id: str) -> bool:
    """Cascade the KB's chunks, docs, and managed corpus dir. The operator's
    source_dir is left untouched."""
    if await _get_base(kb_id) is None:
        return False
    await db.execute("DELETE FROM knowledge_chunks WHERE kb_id = ?", (kb_id,))
    await db.execute("DELETE FROM knowledge_docs WHERE kb_id = ?", (kb_id,))
    await db.execute("DELETE FROM knowledge_bases WHERE id = ?", (kb_id,))
    cdir = corpus_dir(kb_id)
    if cdir.exists():
        shutil.rmtree(cdir, ignore_errors=True)  # managed dir only, never source_dir
    return True


async def start_index(kb_id: str) -> dict:
    """Kick off the background indexer. Raises KeyError (404) for an unknown KB and
    ValueError (409) while one is already indexing — the memory_import.start_scan
    shape."""
    base = await _get_base(kb_id)
    if base is None:
        raise KeyError(kb_id)
    if base.get("status") == "indexing":
        raise ValueError("an index run is already in progress")
    await db.execute(
        "UPDATE knowledge_bases SET status = 'indexing', error = NULL WHERE id = ?",
        (kb_id,),
    )
    asyncio.create_task(_index(kb_id), name=f"kb-index-{kb_id[:8]}")
    return await _get_base(kb_id)


# ---- the indexer (background task — NEVER raises out) ------------------------

async def _index(kb_id: str) -> None:
    """Diff the corpus against knowledge_docs, embed new/changed docs in batches,
    upsert chunks as packed float32 BLOBs + precomputed norms, and settle the KB to
    ready|error. A doc is re-embedded only when its content sha changes; deleted
    files are pruned. NEVER raises — a dead embed endpoint or an unreadable tree
    lands as status=error and the process stays up."""
    try:
        base = await _get_base(kb_id)
        if base is None:
            return
        cfg = await get_config()
        provider, model = cfg["provider_key"], cfg["model"]
        source = Path(base["source_dir"])
        if not source.is_dir():
            await db.execute(
                "UPDATE knowledge_bases SET status='error', error=?, last_indexed_at=? WHERE id=?",
                (f"source directory not found: {source}", utcnow(), kb_id),
            )
            return

        seen: set[str] = set()
        doc_total = 0
        chunk_total = 0
        for rel, size, mtime in _walk_corpus(source):
            text = _read_text(source / rel)
            if text is None:  # binary / unreadable — not part of the corpus
                continue
            rel_str = str(rel).replace("\\", "/")
            seen.add(rel_str)
            # sha over the (capped) text is the definitive change check; mtime/size
            # are stored for display and a cheap human diff.
            sha = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()
            existing = await db.fetch_one(
                "SELECT id, sha, chunk_count FROM knowledge_docs WHERE kb_id=? AND rel_path=?",
                (kb_id, rel_str),
            )
            if existing and existing["sha"] == sha:  # unchanged — keep its chunks
                doc_total += 1
                chunk_total += existing["chunk_count"] or 0
                continue

            chunks = chunk_text(text)
            doc_id = existing["id"] if existing else str(uuid.uuid4())
            if not chunks:  # went empty — drop any stale doc + chunks for this path
                if existing:
                    await db.execute("DELETE FROM knowledge_chunks WHERE doc_id=?", (doc_id,))
                    await db.execute("DELETE FROM knowledge_docs WHERE id=?", (doc_id,))
                continue

            vectors: list[list[float]] = []
            for i in range(0, len(chunks), EMBED_BATCH):
                batch = chunks[i:i + EMBED_BATCH]
                got = await dispatch_embeddings(provider, batch, model=model)
                if len(got) != len(batch):
                    raise IntegrationError(
                        f"embedder returned {len(got)} vectors for {len(batch)} inputs")
                vectors.extend(got)

            await db.execute("DELETE FROM knowledge_chunks WHERE doc_id=?", (doc_id,))
            for ordinal, (chunk, vec) in enumerate(zip(chunks, vectors)):
                blob, dim, norm = _pack(vec)
                await db.execute(
                    "INSERT INTO knowledge_chunks (id, kb_id, doc_id, ordinal, text, embedding, dim, norm)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), kb_id, doc_id, ordinal, chunk, blob, dim, norm),
                )
            now = utcnow()
            if existing:
                await db.execute(
                    "UPDATE knowledge_docs SET size=?, mtime=?, sha=?, chunk_count=?, indexed_at=? WHERE id=?",
                    (size, mtime, sha, len(chunks), now, doc_id),
                )
            else:
                await db.execute(
                    "INSERT INTO knowledge_docs (id, kb_id, rel_path, size, mtime, sha, chunk_count, indexed_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (doc_id, kb_id, rel_str, size, mtime, sha, len(chunks), now),
                )
            doc_total += 1
            chunk_total += len(chunks)

        # prune docs whose files vanished from the corpus
        for r in await db.fetch_all("SELECT id, rel_path FROM knowledge_docs WHERE kb_id=?", (kb_id,)):
            if r["rel_path"] not in seen:
                await db.execute("DELETE FROM knowledge_chunks WHERE doc_id=?", (r["id"],))
                await db.execute("DELETE FROM knowledge_docs WHERE id=?", (r["id"],))

        await db.execute(
            "UPDATE knowledge_bases SET status='ready', error=NULL, doc_count=?, chunk_count=?,"
            " last_indexed_at=? WHERE id=?",
            (doc_total, chunk_total, utcnow(), kb_id),
        )
    except Exception as exc:  # noqa: BLE001 — a background task must never raise out
        log.exception("knowledge index failed for %s", kb_id)
        try:
            await db.execute(
                "UPDATE knowledge_bases SET status='error', error=?, last_indexed_at=? WHERE id=?",
                (str(exc)[:300], utcnow(), kb_id),
            )
        except Exception:  # noqa: BLE001 — even the error write mustn't escape
            pass


# ---- retrieval (brute-force cosine — NEVER raises into the caller) -----------

async def search(kb_ids: list[str], query: str, k: int | None = None) -> list[dict]:
    """Embed the query once, brute-force cosine against every chunk in the given
    KBs (using the precomputed norms), and return the top-k as
    [{text, kb_id, rel_path, score}]. Guards to [] on ANY failure — a dead embed
    endpoint, a bad KB id, or a malformed BLOB must never raise into the runner."""
    try:
        kb_ids = [str(x) for x in (kb_ids or []) if x]
        if not kb_ids or not (query or "").strip():
            return []
        cfg = await get_config()
        k = int(k) if k else cfg["top_k"]
        if k < 1:
            return []
        try:
            vectors = await dispatch_embeddings(cfg["provider_key"], [query], model=cfg["model"])
        except IntegrationError:
            return []
        if not vectors:
            return []
        q = array.array("f", vectors[0])
        qnorm = math.sqrt(sum(x * x for x in q))
        if qnorm == 0:
            return []

        placeholders = ",".join("?" for _ in kb_ids)
        rows = await db.fetch_all(
            "SELECT c.kb_id AS kb_id, c.text AS text, c.embedding AS embedding, c.norm AS norm,"
            " d.rel_path AS rel_path"
            " FROM knowledge_chunks c JOIN knowledge_docs d ON c.doc_id = d.id"
            f" WHERE c.kb_id IN ({placeholders})",
            tuple(kb_ids),
        )
        scored: list[tuple[float, dict]] = []
        for r in rows:
            blob, cnorm = r["embedding"], r["norm"]
            if not blob or not cnorm:
                continue
            vec = _unpack(blob)
            if len(vec) != len(q):
                continue
            dot = math.fsum(a * b for a, b in zip(q, vec))
            score = dot / (qnorm * cnorm)
            scored.append((score, {
                "text": r["text"], "kb_id": r["kb_id"],
                "rel_path": r["rel_path"], "score": round(score, 6),
            }))
        scored.sort(key=lambda t: t[0], reverse=True)
        return [d for _, d in scored[:k]]
    except Exception:  # noqa: BLE001 — retrieval failures degrade to no context, never raise
        log.exception("knowledge search failed")
        return []
