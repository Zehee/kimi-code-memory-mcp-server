# Contributing

Thank you for your interest in improving Kimi Code Memory MCP Server!

## Development Setup

```bash
git clone https://github.com/Zehee/kimi-code-memory-mcp-server.git
cd kimi-code-memory-mcp-server
npm install
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm test` | Run integration tests |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Run ESLint with auto-fix |
| `npm run format` | Format code with Prettier |
| `npm start` | Start the MCP server |

## Before Submitting a Pull Request

1. **Run tests**
   ```bash
   npm test
   ```

2. **Run linting**
   ```bash
   npm run lint
   ```

3. **Format code**
   ```bash
   npm run format
   ```

4. **Update documentation** if your change affects user-facing behavior.

5. **Update `CHANGELOG.md`** under the `Unreleased` section.

## Code Style

- We use ESLint and Prettier. Run `npm run format` before committing.
- Use JSDoc comments for public functions.
- Keep functions small and focused.
- Prefer explicit error messages over silent failures.

## Commit Messages

Use clear, descriptive commit messages in English or Chinese. For example:

```text
feat: add search_context tool test
docs: update README quick start example
fix: handle missing frontmatter in recall
```

## Reporting Bugs

Use the [bug report issue template](../.github/ISSUE_TEMPLATE/bug_report.md).

Include:
- Node.js version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs or error messages

## Proposing Features

Use the [feature request issue template](../.github/ISSUE_TEMPLATE/feature_request.md).

Explain:
- The problem you want to solve
- Your proposed solution
- Why it fits the project's design principles

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
