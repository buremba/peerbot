#!/usr/bin/env python3
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bench_protocol import serve  # noqa: E402

BASE_URL = (os.environ.get('SUPERMEMORY_BASE_URL') or 'https://api.supermemory.ai').rstrip('/')
API_KEY = os.environ.get('SUPERMEMORY_API_KEY')


def env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {'1', 'true', 'yes', 'on'}


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise RuntimeError(f'Invalid float for {name}: {raw}') from exc


def env_search_mode() -> str:
    value = (os.environ.get('SUPERMEMORY_SEARCH_MODE') or 'memories').strip().lower()
    if value not in {'memories', 'hybrid'}:
        raise RuntimeError(
            f"Invalid SUPERMEMORY_SEARCH_MODE {value!r}; expected 'memories' or 'hybrid'"
        )
    return value


def require_api_key() -> str:
    if not API_KEY:
        raise RuntimeError('Missing SUPERMEMORY_API_KEY')
    return API_KEY


def build_ssl_context() -> ssl.SSLContext | None:
    if not env_flag('SUPERMEMORY_INSECURE_SSL', False):
        return None
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def post_json(path: str, body: Dict[str, Any]) -> Any:
    api_key = require_api_key()
    req = urllib.request.Request(
        f'{BASE_URL}{path}',
        data=json.dumps(body).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {api_key}',
            'User-Agent': 'owletto-supermemory-benchmark-adapter',
        },
        method='POST',
    )
    ssl_context = build_ssl_context()
    try:
        with urllib.request.urlopen(req, timeout=60, context=ssl_context) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode('utf-8', 'ignore')
        raise RuntimeError(f'Supermemory API error {exc.code}: {body_text}') from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f'Supermemory request failed: {exc}') from exc


def chunked(values: List[Any], size: int) -> List[List[Any]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


def container_tag(payload: Dict[str, Any]) -> str:
    run_id = str(payload.get('runId') or 'benchmark-run')
    return f'owletto:{run_id}'[:100]


def normalize_metadata(metadata: Dict[str, Any] | None) -> Dict[str, Any]:
    if not metadata:
        return {}
    normalized: Dict[str, Any] = {}
    for key, value in metadata.items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            normalized[key] = value
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            normalized[key] = value
        else:
            normalized[key] = json.dumps(value, sort_keys=True)
    return normalized


def split_content(content: str, max_chars: int = 9500) -> List[str]:
    text = content.strip()
    if len(text) <= max_chars:
        return [text]

    paragraphs = text.split('\n\n')
    chunks: List[str] = []
    current = ''
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        candidate = f'{current}\n\n{paragraph}'.strip() if current else paragraph
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            chunks.append(current)
            current = ''
        while len(paragraph) > max_chars:
            chunks.append(paragraph[:max_chars])
            paragraph = paragraph[max_chars:]
        current = paragraph
    if current:
        chunks.append(current)
    return chunks or [text[:max_chars]]


def action_reset(payload: Dict[str, Any]) -> Any:
    # No-op: each run uses a unique containerTag derived from runId.
    return None


def action_setup(payload: Dict[str, Any]) -> Any:
    # No-op: Supermemory creates containers lazily on first write.
    return None


def action_ingest(payload: Dict[str, Any]) -> Any:
    scenario = payload.get('scenario') or {}
    steps = scenario.get('steps') or []
    memories: List[Dict[str, Any]] = []
    for step in steps:
        content = step.get('content')
        if not isinstance(content, str) or not content.strip():
            continue
        base_metadata = normalize_metadata(step.get('metadata'))
        base_metadata.update(
            {
                'benchmark_id': step.get('id'),
                'scenario_id': scenario.get('id'),
                'step_kind': step.get('kind'),
            }
        )
        if step.get('kind') == 'memory':
            base_metadata['semantic_type'] = step.get('semanticType')
        elif step.get('kind') == 'relationship':
            base_metadata['relationship_type'] = step.get('relationshipType')

        parts = split_content(content)
        for index, part in enumerate(parts):
            metadata = dict(base_metadata)
            metadata['chunk_index'] = index
            metadata['chunk_count'] = len(parts)
            memories.append(
                {
                    'content': part,
                    'metadata': metadata,
                    'isStatic': False,
                }
            )

    created = []
    for batch in chunked(memories, 100):
        if not batch:
            continue
        result = post_json(
            '/v4/memories',
            {
                'containerTag': container_tag(payload),
                'memories': batch,
            },
        )
        created.extend(result.get('memories') or [])

    return {'created': len(created)}


def action_retrieve(payload: Dict[str, Any]) -> Any:
    top_k = int(payload.get('topK') or 8)
    threshold = env_float('SUPERMEMORY_THRESHOLD', 0)
    use_profile = env_flag('SUPERMEMORY_USE_PROFILE', False)
    rerank = env_flag('SUPERMEMORY_RERANK', False)
    search_mode = env_search_mode()

    started = time.perf_counter()
    if use_profile:
        result = post_json(
            '/v4/profile',
            {
                'q': payload.get('prompt') or '',
                'containerTag': container_tag(payload),
                'threshold': threshold,
            },
        )
        search_results = result.get('searchResults')
        if isinstance(search_results, dict):
            entries = search_results.get('results') or []
        elif isinstance(search_results, list):
            entries = search_results
        else:
            entries = result.get('results') or []
        profile = result.get('profile') if isinstance(result.get('profile'), dict) else {}
        static_facts = profile.get('static') if isinstance(profile.get('static'), list) else []
        dynamic_facts = profile.get('dynamic') if isinstance(profile.get('dynamic'), list) else []
        context_lines = []
        if static_facts:
            context_lines.append('Profile (static):')
            context_lines.extend(f'- {value}' for value in static_facts if isinstance(value, str) and value.strip())
        if dynamic_facts:
            context_lines.append('Profile (dynamic):')
            context_lines.extend(f'- {value}' for value in dynamic_facts if isinstance(value, str) and value.strip())
        context_prefix = '\n'.join(context_lines).strip() or None
    else:
        result = post_json(
            '/v4/search',
            {
                'q': payload.get('prompt') or '',
                'containerTag': container_tag(payload),
                'limit': top_k,
                'searchMode': search_mode,
                'threshold': threshold,
                'rerank': rerank,
            },
        )
        entries = result.get('results') or []
        context_prefix = None
    latency_ms = (time.perf_counter() - started) * 1000

    grouped: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
        text = entry.get('memory') or entry.get('chunk') or ''
        benchmark_id = str(metadata.get('benchmark_id') or entry.get('id'))
        existing = grouped.get(benchmark_id)
        if existing is None:
            grouped[benchmark_id] = {
                'id': benchmark_id,
                'text': text,
                'score': entry.get('similarity'),
                'sourceType': 'memory',
                'metadata': metadata,
            }
            continue
        if text and text not in existing['text']:
            existing['text'] = f"{existing['text']}\n\n{text}".strip()
        existing['score'] = max(existing.get('score') or 0, entry.get('similarity') or 0)

    items = sorted(grouped.values(), key=lambda item: item.get('score') or 0, reverse=True)
    return {'items': items[:top_k], 'latencyMs': latency_ms, 'contextPrefix': context_prefix, 'raw': result}


ACTIONS = {
    'reset': action_reset,
    'setup': action_setup,
    'ingest': action_ingest,
    'retrieve': action_retrieve,
}


if __name__ == '__main__':
    raise SystemExit(serve(ACTIONS))
