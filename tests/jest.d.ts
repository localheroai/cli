// Type definitions for Jest globals in TypeScript tests

declare global {
  /**
   * Marks a test as failed if it's called, useful in conditional blocks
   * where a path should not be executed.
   */
  function fail(message?: string): never;

  /**
   * Used to provide a description of the current test context.
   */
  const currentTest: {
    /**
     * The name of the test
     */
    name: string;

    /**
     * The fully qualified test name including describe blocks
     */
    fullName: string;
  };
}