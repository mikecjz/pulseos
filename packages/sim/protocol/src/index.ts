/**
 * Shared PulseOS simulation contract between engines (MCP servers), the DSH host plugins and the
 * browser panel. Pure TypeScript with no runtime dependencies, so the panel can bundle it.
 * @module @pulseos/sim-protocol
 */
export * from './contract.ts'
export * from './records.ts'
