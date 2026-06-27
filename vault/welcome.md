# Welcome to your RAG Vault

This file lives in the **vault directory** — a plain folder on your computer
(`./vault` by default, or set `VAULT_DIR` to point anywhere, including a folder
outside this repo for private documents).

Anything you drop in here becomes browsable in the explorer. Toggle a file
**in** to make it retrievable by the chat, or **out** to hide it. The chat only
ever answers from what is currently included.

## Try it

1. Make sure this file (and the notes folder) are **included** in the explorer.
2. Ask the chat: *"What is the vault directory and how does retrieval work?"*
3. The answer is grounded in these files, with the source passages shown below it.

To get synthesized (rather than extractive) answers, add an Anthropic API key in
onboarding — it is stored locally in `vault/.rag-vault/profile.json` and never
leaves your machine.
