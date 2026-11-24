/**
 * Type of TSL node expressions. three's TSL typings cannot express the node graphs written
 * here (swizzles, `.toVar()`, math chained on `uniform()` results), so nodes are typed loosely.
 * Lives in `core/` because every layer that builds shaders uses it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TSLNode = any;
