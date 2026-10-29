export interface DatabaseError {
  readonly kind:
    | "invalid_input"
    | "invalid_environment"
    | "invalid_row"
    | "not_found"
    | "conflict"
    | "database_error"
    | "crypto_error";
  /** Safe for logs; never contains credentials or database driver messages. */
  readonly message: string;
}
