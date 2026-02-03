# Browser Challenge Agent

Autonomous browser agent to solve 30 UI challenges in under 5 minutes.

**Challenge**: https://serene-frangipane-7fd25b.netlify.app

## Strategy

Based on analysis of the challenge:
- Non-visual DOM rendering for speed (avoid slow screenshot processing)
- Parallel agents to map action space
- Fast model (Gemini 3 Flash or similar) for modal taxonomy
- Centralized skills/memory for challenge patterns
- Main orchestrator agent for decision making

## Requirements

- Node.js 20+
- Python 3.11+
- Browser automation tools (Playwright/Puppeteer)

## Setup

```bash
# Install dependencies
npm install
pip install -r requirements.txt

# Run the agent
npm run solve
```

## Metrics

The agent tracks:
- Total time taken
- Token usage per model
- Token cost breakdown
- Success rate per challenge type

## Architecture

```
browser-challenge/
├── src/
│   ├── agent/          # Main orchestrator
│   ├── workers/        # Parallel DOM exploration agents
│   ├── skills/         # Learned patterns for modal types
│   └── browser/        # Browser automation layer
├── metrics/            # Run statistics output
└── README.md
```

## Submission

Package as zip with:
1. This repo
2. Run instructions
3. metrics/ folder with latest run statistics
