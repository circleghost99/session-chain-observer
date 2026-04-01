# session-chain-observer

OpenClaw plugin for progressive-disclosure observation of agent session execution chains.

Designed for the skill-optimizer agent to analyze tool call patterns, diagnose errors, and identify improvement opportunities — without consuming excessive context window tokens.

## Architecture

Three-layer progressive disclosure:

| Layer | Tool | Token Cost | Purpose |
|-------|------|-----------|---------|
| L0 | `chain_summary` | ~200-400/session | Quick overview: success/fail, tool counts, errors, cost |
| L1 | `chain_steps` | ~80-150/step | Timeline: each tool call with truncated I/O |
| L2 | `chain_detail` | ~500-5000/step | Full I/O + agent thinking for a specific step |
| Cross | `chain_patterns` | varies | Recurring errors and cost trends across sessions |

A typical diagnostic flow (`summary → steps → detail`) costs ~4,000 tokens vs ~30,000+ for raw transcript loading — a **7-10x reduction**.

## Tools

### `chain_summary`

Lightweight execution summary for one or more sessions. Always start here.

```
chain_summary({ agentId: "lobster-support", hoursBack: 24 })
chain_summary({ sessionKey: "agent:main:discord:channel:123" })
```

### `chain_steps`

Tool call timeline with filtering and pagination.

```
chain_steps({ sessionKey: "...", filter: "errors" })
chain_steps({ sessionKey: "...", around: 29 })         // ±5 steps around step 29
chain_steps({ sessionKey: "...", toolFilter: "exec" })
```

### `chain_detail`

Full input/output for a specific step, including agent thinking context.

```
chain_detail({ sessionKey: "...", step: 29 })
chain_detail({ sessionKey: "...", step: 29, includeThinking: true })
```

### `chain_patterns`

Cross-session pattern analysis for systematic skill improvement.

```
chain_patterns({ agentId: "lobster-support", hoursBack: 168 })
chain_patterns({ agentId: "hamster-collector", focus: "errors" })
```

## Installation

1. Clone into your OpenClaw local-plugins directory:
   ```bash
   cd ~/.openclaw/local-plugins
   git clone <repo-url> session-chain-observer
   cd session-chain-observer
   npm install
   ```

2. Enable in `openclaw.json`:
   ```json
   {
     "plugins": {
       "entries": {
         "session-chain-observer": {
           "enabled": true,
           "config": {
             "maxStepsPerPage": 50,
             "maxDetailChars": 8000
           }
         }
       }
     }
   }
   ```

3. Restart gateway:
   ```bash
   openclaw gateway restart
   ```

## Web Interface

The plugin also includes a built-in web dashboard to visualize session chains directly in your browser.

To start the web server:
```bash
cd ~/.openclaw/local-plugins/session-chain-observer
npm run serve
```
Then open [http://localhost:18790](http://localhost:18790) in your browser.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `maxStepsPerPage` | 50 | Max steps per page in `chain_steps` |
| `maxDetailChars` | 8000 | Max chars for tool output in `chain_detail` |
| `summaryInputChars` | 120 | Max chars for input summaries |
| `summaryOutputChars` | 200 | Max chars for output summaries |
| `debug` | false | Enable debug logging |

## License

MIT
