PORT ?= 8787
RUN_DIR := .wrangler
PID_FILE := $(RUN_DIR)/dev.pid
LOG_FILE := $(RUN_DIR)/dev.log
WRANGLER := node_modules/.bin/wrangler
NODE_MIN := 20

.PHONY: prepare start stop restart status logs

## prepare: check Node, install missing/outdated deps, create .dev.vars, apply pending local migrations.
## Does nothing when everything is already set up.
prepare:
	@command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || { \
		echo "✗ Node.js and npm are required (Node $(NODE_MIN)+): https://nodejs.org"; exit 1; }; \
	major=$$(node -p 'process.versions.node.split(".")[0]'); \
	if [ "$$major" -lt $(NODE_MIN) ]; then echo "✗ Node $(NODE_MIN)+ required, found $$(node -v)"; exit 1; fi; \
	echo "✓ Node $$(node -v)"; \
	if [ ! -f node_modules/.package-lock.json ] \
		|| [ package.json -nt node_modules/.package-lock.json ] \
		|| [ package-lock.json -nt node_modules/.package-lock.json ] \
		|| ! npm ls --depth=0 >/dev/null 2>&1; then \
		echo "→ Installing dependencies..."; npm install --no-fund --no-audit || exit 1; \
	else echo "✓ Dependencies up to date"; fi; \
	if [ ! -f .dev.vars ]; then \
		cp .dev.vars.example .dev.vars; echo "→ Created .dev.vars from .dev.vars.example"; \
	else echo "✓ .dev.vars present"; fi; \
	if $(WRANGLER) d1 migrations list DB --local 2>&1 | grep -q "No migrations to apply"; then \
		echo "✓ Local database up to date"; \
	else \
		echo "→ Applying local database migrations..."; \
		out=$$($(WRANGLER) d1 migrations apply DB --local 2>&1) || { echo "$$out"; echo "✗ Migrations failed"; exit 1; }; \
		echo "✓ Local database migrated"; \
	fi

## start: prepare, then run the app in the background
start: prepare
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Already running on http://localhost:$(PORT) (pid $$(cat $(PID_FILE)))"; exit 0; \
	fi; \
	mkdir -p $(RUN_DIR); \
	setsid $(WRANGLER) dev --port $(PORT) > $(LOG_FILE) 2>&1 < /dev/null & echo $$! > $(PID_FILE); \
	for i in $$(seq 1 60); do \
		if grep -q "Ready on" $(LOG_FILE); then echo "Bingo running on http://localhost:$(PORT)  (logs: make logs, stop: make stop)"; exit 0; fi; \
		if ! kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then echo "Failed to start:"; tail -20 $(LOG_FILE); rm -f $(PID_FILE); exit 1; fi; \
		sleep 0.5; \
	done; \
	echo "Still starting after 30s, check: make logs"

## stop: stop the background app
stop:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		kill -- -$$(cat $(PID_FILE)) 2>/dev/null || kill $$(cat $(PID_FILE)); \
		rm -f $(PID_FILE); echo "Stopped."; \
	else \
		rm -f $(PID_FILE); echo "Not running."; \
	fi

restart: stop start

status:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Running on http://localhost:$(PORT) (pid $$(cat $(PID_FILE)))"; \
	else echo "Not running."; fi

logs:
	@tail -f $(LOG_FILE)
