/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Compare use-cases.
 *
 * The controller is per feature; handlers are per endpoint. That division is
 * what stops this becoming a pass-through — orchestration that spans services
 * lives here, and it is the single place a resource check or a cache lookup can
 * be attached so no endpoint can skip one.
 *
 * No HTTP types: this is callable from a CLI, a worker or a test.
 */
import type { ActorContext } from '../../platform/contracts/actor';
import type { CompareInput, CompareOutput, CompareService } from './compare.service';

export interface CompareController {
  compare(input: CompareInput, actor: ActorContext): Promise<CompareOutput>;
}

export function makeCompareController(deps: {
  compareService: CompareService;
}): CompareController {
  return {
    /**
     * Forwards to the service, which performs its own permission check.
     *
     * This layer exists as the place where cross-cutting work runs before the
     * service: resource-level authorization and the scope-aware cache both
     * attach here, so an endpoint cannot skip them. See
     * docs/plans/api-restructure.md §4 and §6.
     */
    compare(input, actor) {
      return deps.compareService.compare(input, actor);
    },
  };
}
