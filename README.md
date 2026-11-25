# pi-plan-execute

PLAN/EXEC modes for pi: read-only planning, then execute the approved plan on a clean context.

## Install

```bash
git clone https://github.com/trfar/pi-plan-execute.git ~/.pi/agent/extensions/pi-plan-execute
```

Register in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["~/.pi/agent/extensions/pi-plan-execute/index.ts"] }
```

## Usage

- Sessions start in **PLAN** (read-only); `/plan` cycles PLAN → EXEC → default.
- **Settling** - the plan is shown in the transcript with an Execute / Continue Planning choice.
- **Executing** - the executor starts with only the plan, not the planning chat. After the run,
  your next message returns to **PLAN**.

Plan colors are `PLAN_COLOR` / `EXEC_COLOR` at the top of `index.ts`.
