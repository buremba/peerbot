# CLAUDE.md

- Always use Skaffold to build and run the Slack bot.
- NEVER create files unless they're absolutely necessary for achieving your goal. Instead try to run the code on the fly for testing reasons.
- ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User. If you need to remember something, add it to CLAUDE.md as a a single sentence.
- You need to use Skaffold with Docker Desktop to build and test the code.
- Anytime you make changes in the code that should be tested, run ./test-bot.js and make sure it works properly.
- Use `make dev` to start Skaffold in development mode with auto-rebuild, or see Makefile for other useful commands.
