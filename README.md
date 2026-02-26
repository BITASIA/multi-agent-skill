# multi-agent-skill - Multi-Agent Workflow Engineering Skill

An engineering skill for building reliable multi-agent systems by treating agents like distributed systems, not chat flows. Compatible with any AI coding agent that supports the [Agent Skills](https://skills.sh) specification.

## Features

- **12 reference documents** covering foundations, schemas, orchestration, failure modes, and testing
- **14 production-ready templates** for schemas, MCP tools, orchestration, and testing
- **5 specialized agents** for architecture, schema engineering, contract review, failure analysis, and optimization
- **6 slash commands** for common multi-agent workflows
- **Framework-agnostic** - pure TypeScript/Zod patterns that work with any multi-agent implementation
- Based on [Multi-agent workflows often fail. Here's how to engineer ones that don't](https://github.blog/ai-and-ml/generative-ai/multi-agent-workflows-often-fail-heres-how-to-engineer-ones-that-dont/)

## Installation

### Option 1: skills.sh (recommended)

```sh
npx skills add BITASIA/multi-agent-skill
```

### Option 2: Clone and symlink (development)

```sh
git clone https://github.com/BITASIA/multi-agent-skill.git ~/code/multi-agent-skill
ln -s ~/code/multi-agent-skill ~/.claude/skills/multi-agent-skill
```

### Option 3: Direct clone into skills directory

```sh
git clone https://github.com/BITASIA/multi-agent-skill.git ~/.claude/skills/multi-agent-skill
```

### Verify installation

```sh
ls -la ~/.claude/skills/multi-agent-skill/SKILL.md
```

The skill should now appear when your agent lists available skills.

## Usage

Once installed, the skill activates automatically when you work on multi-agent systems. You can also:

- Use specialized agents: "Use the workflow-architect agent to design my agent pipeline"
- Run slash commands: `/design-workflow`, `/review-agents`, `/generate-schemas`
- Reference documentation: "Check the failure-modes-catalog reference for cascade failure prevention"

## Core Patterns

1. **Typed Schemas** - Zod schemas at every agent boundary to prevent silent data failures
2. **Action Schemas** - Discriminated union types for all agent actions to eliminate ambiguity
3. **MCP Contracts** - Tool definitions with input/output validation to prevent integration drift

## What's Included

### Reference Documentation
12 comprehensive guides covering foundations, typed schemas, action schemas, MCP contracts, orchestration patterns, state management, failure modes, retry strategies, observability, testing, decision frameworks, and anti-patterns.

### Templates
14 production-ready TypeScript templates across schemas, MCP tools, orchestration patterns, and testing utilities.

### Agents
5 specialized agents: Workflow Architect, Schema Engineer, Contract Reviewer, Failure Analyst, Orchestration Optimizer.

### Commands
6 slash commands: design-workflow, review-agents, generate-schemas, generate-mcp-tool, failure-analysis, single-vs-multi.

## Full Documentation

See [SKILL.md](SKILL.md) for comprehensive documentation, code examples, design principles, and decision frameworks.

## License

MIT
