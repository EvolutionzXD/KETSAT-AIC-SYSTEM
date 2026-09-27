"""DeepSeek API translator (OpenAI-compatible chat completions).

DeepSeek V4's document-translation quality is on par with Gemini 3 Pro / GPT
for this task, and it is cheap. The real trade-off vs an offline model is the
external-network dependency at competition time — hence the pluggable design
with an offline fallback (see composite.FallbackTranslator).

The API key comes from the environment (DEEPSEEK_API_KEY); never hardcode it.
"""
from __future__ import annotations

from typing import Callable, Optional

from .base import QueryTranslator, TranslationError

#: DeepSeek's chat alias tracks their latest general model (V4 line). Override
#: via ``model=`` / TRANSLATION_MODEL if a specific pinned id is needed.
DEFAULT_MODEL = "deepseek-chat"
DEFAULT_BASE_URL = "https://api.deepseek.com"

_SYSTEM_PROMPT = (
    "You translate Vietnamese video-search queries into English for a "
    "PE-Core/BEiT-3 visual retrieval system. Produce one concise, literal English "
    "description that preserves every visual detail: objects, people and their "
    "count, actions, spatial relations, colours, and the meaning of any "
    "on-screen text. Do not add commentary, alternatives, or quotation marks. "
    "Output ONLY the English translation on a single line."
)

#: (url, headers, payload) -> parsed JSON dict. Injectable so tests need no
#: network and no API key.
Transport = Callable[[str, dict, dict], dict]


class DeepSeekTranslator(QueryTranslator):
    """Translate via DeepSeek's OpenAI-compatible chat endpoint."""

    name = "deepseek"

    def __init__(
        self,
        api_key: Optional[str],
        *,
        model: str = DEFAULT_MODEL,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        temperature: float = 0.0,
        transport: Optional[Transport] = None,
    ):
        if not api_key:
            raise TranslationError(
                "DeepSeek API key is required (set DEEPSEEK_API_KEY)"
            )
        self._api_key = api_key
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._temperature = temperature
        self._transport = transport

    def _default_transport(self, url: str, headers: dict, payload: dict) -> dict:
        import requests

        response = requests.post(
            url, headers=headers, json=payload, timeout=self._timeout
        )
        response.raise_for_status()
        return response.json()

    def translate(self, text: str) -> str:
        text = text.strip()
        if not text:
            return ""

        url = f"{self._base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self._model,
            "temperature": self._temperature,
            "stream": False,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
        }

        transport = self._transport or self._default_transport
        try:
            data = transport(url, headers, payload)
            content = data["choices"][0]["message"]["content"]
        except TranslationError:
            raise
        except Exception as exc:  # network, HTTP, malformed body
            raise TranslationError(f"DeepSeek translation failed: {exc}") from exc

        result = str(content).strip()
        if not result:
            raise TranslationError("DeepSeek returned an empty translation")
        return result
