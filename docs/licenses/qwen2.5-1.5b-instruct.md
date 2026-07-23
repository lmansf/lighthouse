# Third-party model notice — Qwen2.5-1.5B-Instruct

§42 Tier-2 ships an on-device fallback model on iOS devices without Apple
Foundation Models. The model weights are **downloaded on demand with the
user's consent** (never bundled in the app), from the official repository:

- **Model:** Qwen2.5-1.5B-Instruct (GGUF, Q4_K_M quantization,
  `qwen2.5-1.5b-instruct-q4_k_m.gguf`, ~1.12 GB)
- **Source:** https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF
- **Copyright:** © Alibaba Cloud
- **License:** Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0

The Apache-2.0 license requires preserving the copyright and license notice.
The in-app attribution (Settings → About) reads, verbatim:

> Includes Qwen2.5-1.5B-Instruct © Alibaba Cloud, used under the Apache
> License 2.0.

If the fallback model (SmolLM2-1.7B-Instruct, © Hugging Face, also
Apache-2.0 — https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF)
ships instead, the attribution names it in the same form.

The model is inference **data**, not executable code: llama.cpp runs it
ahead-of-time on-device with Metal, with no runtime code generation (no JIT).
