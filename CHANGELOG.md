# Changelog

## [1.0.2](https://github.com/markaspot/markaspot-mcp/compare/v1.0.1...v1.0.2) (2026-09-28)

### Bug Fixes

* rebuild on the current hardened Node base image, which ships OpenSSL 3.5.7 (CVE-2026-14456)

## [1.0.1](https://github.com/markaspot/markaspot-mcp/compare/v1.0.0...v1.0.1) (2026-08-20)

### Bug Fixes

* align stateless discovery capabilities with the methods it safely supports

## [1.0.0](https://github.com/markaspot/markaspot-mcp/compare/v1.0.0-rc.0...v1.0.0) (2026-07-02)

### Features

* add marketplace gateway deploy config and tenant onboarding script ([607334f](https://github.com/markaspot/markaspot-mcp/commit/607334f9ca54f9f9dfefd32dde45bed24dc4bfd1))

### Bug Fixes

* prevent tenant enumeration via initialize and add tenant-pinning tests ([7802a89](https://github.com/markaspot/markaspot-mcp/commit/7802a89dd9a52784d3efe056723b55dba13d776a))
* scope list_tenants to the token tenant pin ([8593682](https://github.com/markaspot/markaspot-mcp/commit/859368244667cefafa9c796d25d3512f28a2721c))

## 1.0.0-rc.0 (2026-06-05)
