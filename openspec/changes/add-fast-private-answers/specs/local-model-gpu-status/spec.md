# local-model-gpu-status — delta

## ADDED Requirements

### Requirement: The AI-models dialog shows the real GPU launch state
When the private model is installed, the desktop app SHALL surface the shell's actual llama-server launch state — whether GPU offload is engaged and, when on, the layer count (`-ngl`) — derived from the real spawn (the `-ngl` argument and the `llmDisableGpu` setting), not guessed. The status SHALL reflect the CPU-only fallback ("off — CPU") when the shell launched without GPU offload.

#### Scenario: GPU on shows the layer count
- **WHEN** the chat llama-server was spawned with GPU offload at 999 layers
- **THEN** the AI-models dialog shows that acceleration is on with the layer count

#### Scenario: CPU fallback shows off
- **WHEN** the shell launched the model CPU-only (GPU disabled or fell back after a Vulkan crash)
- **THEN** the AI-models dialog shows GPU acceleration off / running on CPU

### Requirement: GPU status is desktop-only and absent (rendered as nothing) elsewhere
The GPU launch state SHALL be reported only by the desktop shell, which owns the llama-server process. The web/dev server has no supervisor and SHALL omit the GPU fields; the UI SHALL treat a missing GPU field as "unknown" and render nothing for it, rather than showing a false or blank status. The status SHALL also be absent until a chat server has actually been started this session.

#### Scenario: The web/dev build shows no GPU line
- **WHEN** the app runs against the web/dev server (no supervisor)
- **THEN** no GPU fields are present in the model status and the UI shows no GPU line

#### Scenario: Before the first chat server, no GPU line
- **WHEN** the model is installed but no chat server has started yet this session
- **THEN** no GPU status is shown

### Requirement: GPU status is read-only and adds no launch controls
Surfacing GPU status SHALL NOT add any control over GPU offload and SHALL NOT change the launch logic; it is a read-only reflection of the existing `-ngl`/`llmDisableGpu` behavior and its crash-guard fallback.

#### Scenario: No new offload knob
- **WHEN** the GPU status is shown
- **THEN** it is display-only; the offload behavior and its CPU fallback are unchanged
