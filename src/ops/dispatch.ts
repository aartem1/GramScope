import { z } from "zod";
import { GramScopeError } from "../errors/taxonomy";

export type OperationDefinition<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = {
  name: string;
  input: I;
  output: O;
  // Method syntax keeps the parameter bivariant so a typed domain function
  // (and a test-only handler) still assigns under strictFunctionTypes.
  handler(input: z.output<I>): Promise<z.output<O>> | z.output<O>;
};

export type OperationRegistry = Record<string, OperationDefinition>;

/**
 * In-process dispatcher: lookup, parse input, run the handler, parse output.
 * A handler-thrown GramScopeError is rethrown unchanged so runTool sees the
 * same instance. Unknown ops and output-shape failures become INTERNAL_ERROR
 * without echoing the raw payload.
 */
export function createDispatcher(operations: OperationRegistry) {
  return async function dispatch(
    op: string,
    input: unknown,
  ): Promise<unknown> {
    const definition = operations[op];
    if (definition === undefined) {
      throw new GramScopeError(
        "INTERNAL_ERROR",
        `Unknown operation '${op}'.`,
      );
    }
    const parsedInput = definition.input.parse(input);
    const result = await definition.handler(parsedInput);
    const parsedOutput = definition.output.safeParse(result);
    if (!parsedOutput.success) {
      throw new GramScopeError(
        "INTERNAL_ERROR",
        "Operation produced an invalid result.",
      );
    }
    return result;
  };
}
