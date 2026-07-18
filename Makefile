# Makefile for Mochi apps
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

APP = $(notdir $(CURDIR))
VERSION = $(shell grep -m1 '"version"' app.json | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
RELEASE = ../../release
SAFE_PNPM = $(abspath ../../claude/scripts/safe-pnpm.sh)

all: web/dist/index.html

wasm: web/src/assets/flight.wasm

clean:
	rm -rf web/dist

web/dist/index.html: web/src/assets/flight.wasm $(shell find web/src web/public ../../lib/web/src -type f 2>/dev/null)
	bash -c 'cd web && $(SAFE_PNPM) run build'
# The flight simulation core, compiled for the browser from the world repo.
# Lands in src/assets so Vite content-hashes it into the bundle (no manual
# cache-bust versions); the build products are gitignored there.
web/src/assets/flight.wasm: $(shell find ../../world/games/air ../../world/wasm -name '*.go' 2>/dev/null)
	mkdir -p web/src/assets
	cd ../../world && GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o ../apps/air/web/src/assets/flight.wasm ./wasm
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" web/src/assets/

release: web/dist/index.html
	rm -f $(RELEASE)/$(APP)_*.zip
	zip -r $(RELEASE)/$(APP)_$(VERSION).zip app.json *.star labels web/dist
	git tag -a $(VERSION) -m "$(VERSION)" 2>/dev/null || true

deploy:
	../../test/claude/deploy.sh $(APP)

commit:
	git add -A && git commit -m "$(VERSION)" || true

push:
	git push --follow-tags

everything: clean release deploy commit push

install:
	bash -c 'cd web && $(SAFE_PNPM) install'

dev:
	bash -c 'cd web && $(SAFE_PNPM) run dev'

i18n-extract:
	bash -c 'cd web && $(SAFE_PNPM) i18n:extract --clean'
