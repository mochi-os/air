# Makefile for Mochi apps
# Copyright © 2026 Mochi OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

APP = $(notdir $(CURDIR))
VERSION = $(shell grep -m1 '"version"' app.json | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
RELEASE = ../../release
SAFE_PNPM = $(abspath ../../claude/scripts/safe-pnpm.sh)

all: web/dist/index.html

wasm: web/public/flight/flight.wasm

clean:
	rm -rf web/dist

web/dist/index.html: web/public/flight/flight.wasm $(shell find web/src ../../lib/web/src -type f 2>/dev/null)
	bash -c 'cd web && $(SAFE_PNPM) run build'
# The flight simulation core, compiled for the browser from the world repo.
web/public/flight/flight.wasm: $(shell find ../../world/games/furball ../../world/wasm -name '*.go' 2>/dev/null)
	mkdir -p web/public/flight
	cd ../../world && GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o ../apps/furball/web/public/flight/flight.wasm ./wasm
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" web/public/flight/

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
