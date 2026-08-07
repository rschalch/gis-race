.DEFAULT_GOAL := help
.PHONY: help install dev run build preview test typecheck check bake bake-meshes sim-batch clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

dev: ## Start the dev server
	npm run dev

run: ## Start the dev server and open the app in the default browser
	npm run dev -- --open

build: ## Production build
	npm run build

preview: ## Preview the production build
	npm run preview

test: ## Run the test suite
	npm run test

typecheck: ## Type-check with tsc --noEmit
	npm run typecheck

check: typecheck test ## Type-check and run tests

bake: ## Bake a route: make bake ARGS='--from "Origin, ST" --to "Destination, ST" --slug my-route-slug'
	npm run bake -- $(ARGS)


bake-meshes: ## Re-bake the 3D vehicle models from assets/vehicles into public/models
	npm run bake-meshes


sim-batch: ## Run headless batch validation: make sim-batch ARGS='--route sorocaba-campos --seeds 30'
	npm run sim-batch -- $(ARGS)


clean: ## Remove build output and installed dependencies
	rm -rf dist node_modules
