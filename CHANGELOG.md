# Changelog

All notable changes to this project will be documented in this file.

## [1.0.1] - 2026-06-24

### Added
- **Template Manager**: Introduced a new template manager to handle code snippets and blocks.
- **USB Transfer Protocol**: Added support for direct file and program transfer via USB connectivity.

### Changed
- **Siemens 840Di**: Updated and improved support for the Siemens 840Di control:
  - Fixed an issue where variables starting with axis letters (like `Z_POS`) would lose their assignments during sanitization.
  - Parameter parentheses `( )` such as those used in `CYCLE800` are now safely preserved instead of being stripped out as comments.
