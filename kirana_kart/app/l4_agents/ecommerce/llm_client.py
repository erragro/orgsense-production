from __future__ import annotations

from app.operational_metrics import observed

import json
import logging
import os
import re
from typing import Any

from dotenv import load_dotenv
from pathlib import Path
from openai import OpenAI


PROJECT_ROOT = Path(__file__).resolve().parents[4]
load_dotenv(PROJECT_ROOT / ".env")

LLM_API_KEY = os.getenv("LLM_API_KEY")
LLM_API_BASE_URL = os.getenv("LLM_API_BASE_URL", "https://api.openai.com/v1")

logger = logging.getLogger("llm_client")
logger.setLevel(logging.INFO)


class LLMClient:
    def __init__(self):
        if not LLM_API_KEY:
            self.client = None
            logger.warning("LLM_API_KEY not set; LLM calls will fail.")
        else:
            self.client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_API_BASE_URL)

    @observed("llm")
    def chat_json(self, model: str, system: str, user: str) -> dict[str, Any]:
        if not self.client:
            raise RuntimeError("LLM_API_KEY not configured")

        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

        # Prefer strict JSON mode when supported by the model/API.
        try:
            response = self.client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.2,
                response_format={"type": "json_object"},
            )
        except Exception:
            response = self.client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.2,
            )

        content = response.choices[0].message.content or "{}"
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            # Attempt to recover JSON from freeform responses.
            match = re.search(r"\{.*\}", content, re.DOTALL)
            if match:
                try:
                    return json.loads(match.group(0))
                except json.JSONDecodeError:
                    pass
            logger.warning("LLM returned non-JSON content")
            return {"raw_response": content}
