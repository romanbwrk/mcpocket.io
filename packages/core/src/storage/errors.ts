/** Base class for errors raised by storage adapters. */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** An entity with the same id already exists in the collection. */
export class DuplicateIdError extends StorageError {
  constructor(
    readonly collection: string,
    readonly id: string
  ) {
    super(`${collection}: an entity with id "${id}" already exists`)
  }
}
