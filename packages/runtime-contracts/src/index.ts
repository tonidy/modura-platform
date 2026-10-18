/**
 * Canonical error contract shared by every Modura surface: HTTP, SDK, CLI and MCP.
 *
 * Every error belongs to exactly one category, and the category alone decides the
 * transport mapping. Generators and providers never choose status codes per operation.
 * See docs/adr/0003-canonical-error-model.md.
 */

export const errorCategories = {
  validation: { httpStatus: 400 },
  unauthenticated: { httpStatus: 401 },
  forbidden: { httpStatus: 403 },
  not_found: { httpStatus: 404 },
  conflict: { httpStatus: 409 },
  unprocessable: { httpStatus: 422 },
  rate_limited: { httpStatus: 429 },
  internal: { httpStatus: 500 },
  unavailable: { httpStatus: 503 },
} as const satisfies Record<string, { httpStatus: number }>;

export type ErrorCategory = keyof typeof errorCategories;

export interface ErrorDefinition {
  readonly category: ErrorCategory;
  /** True when repeating the same request may succeed without the caller changing anything. */
  readonly retryable: boolean;
  readonly description: string;
}

/**
 * Errors owned by the platform rather than a business module. The compiler attaches
 * them to operations based on traits (every operation can fail validation, only
 * idempotent operations can hit idempotency errors), so modules never declare them.
 */
export const platformErrors = {
  VALIDATION_FAILED: {
    category: 'validation',
    retryable: false,
    description: 'The request does not match the operation input schema.',
  },
  UNAUTHENTICATED: {
    category: 'unauthenticated',
    retryable: false,
    description: 'The request has no valid identity.',
  },
  FORBIDDEN: {
    category: 'forbidden',
    retryable: false,
    description: 'The identity lacks a permission the operation requires.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    category: 'conflict',
    retryable: false,
    description: 'The idempotency key was already used with a different request.',
  },
  IDEMPOTENCY_IN_PROGRESS: {
    category: 'conflict',
    retryable: true,
    description:
      'Another request with the same idempotency key did not finish within the lock timeout.',
  },
  RATE_LIMITED: {
    category: 'rate_limited',
    retryable: true,
    description: 'Too many requests from this client.',
  },
  INTERNAL: {
    category: 'internal',
    retryable: false,
    description: 'An unexpected server error. Details are logged, not returned.',
  },
  UNAVAILABLE: {
    category: 'unavailable',
    retryable: true,
    description: 'A dependency such as the database is temporarily unavailable.',
  },
} as const satisfies Record<string, ErrorDefinition>;

export type PlatformErrorCode = keyof typeof platformErrors;

/** Wire shape of every error response on every surface. */
export interface ModuraError {
  /** Platform code ("FORBIDDEN") or qualified domain code ("sales.INSUFFICIENT_STOCK"). */
  readonly code: string;
  /** Human-readable explanation. Clients match on `code`, never on `message`. */
  readonly message: string;
  readonly retryable: boolean;
  /** Qualified operation name, for example "sales.createSale". */
  readonly operation?: string;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function httpStatusFor(category: ErrorCategory): number {
  return errorCategories[category].httpStatus;
}
