# MCPocket v1 — common dev and Docker tasks.
# Run `make` or `make help` to list targets.

SHELL := /bin/sh
.DEFAULT_GOAL := help

COMPOSE ?= docker compose
# Production stack (app + MongoDB 8): `make up PROD=1`, `make logs PROD=1`, ...
ifdef PROD
COMPOSE := docker compose -f docker-compose.prod.yml
endif
SERVICE ?= mcpocket

.PHONY: help install dev build start lint format typecheck test test-watch check \
        seed sso-token mcp-stdio build-stdio env \
        up down restart logs ps shell health docker-build clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target>\n\n"} \
		/^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

## ---- Local development ----

install: ## Install dependencies (npm ci)
	npm ci

dev: ## Run Next.js dev server
	npm run dev

build: ## Production build
	npm run build

start: ## Start production server (after build)
	npm run start

lint: ## Run ESLint
	npm run lint

format: ## Format code with Prettier
	npm run format

typecheck: ## Type-check with tsc
	npm run typecheck

test: ## Run tests once
	npm test

test-watch: ## Run tests in watch mode
	npm run test:watch

check: lint typecheck test ## Lint, type-check and test

seed: ## Seed data
	npm run seed

sso-token: ## Mint a test SSO login link: make sso-token EMAIL=you@example.com
	npm run sso:token -- $(EMAIL)

mcp-stdio: ## Run the MCP stdio server
	npm run mcp:stdio

build-stdio: ## Bundle the MCP stdio server to dist/
	npm run build:stdio

env: ## Create .env from .env.example if missing
	@test -f .env && echo ".env already exists" || (cp .env.example .env && echo "Created .env — set MCPOCKET_ADMIN_PASSWORD")

## ---- Docker ----

docker-build: ## Build the Docker image
	$(COMPOSE) build

up: ## Build and start the container in the background
	$(COMPOSE) up -d --build

down: ## Stop and remove the container (keeps data volume)
	$(COMPOSE) down

restart: ## Restart the container
	$(COMPOSE) restart $(SERVICE)

logs: ## Follow container logs
	$(COMPOSE) logs -f $(SERVICE)

ps: ## Show container status
	$(COMPOSE) ps

shell: ## Open a shell in the running container
	$(COMPOSE) exec $(SERVICE) sh

health: ## Check the /api/health endpoint
	@curl -fsS http://localhost:$${MCPOCKET_PORT:-3000}/api/health && echo

## ---- Cleanup ----

clean: ## Remove build artifacts (.next, dist)
	rm -rf .next dist tsconfig.tsbuildinfo
