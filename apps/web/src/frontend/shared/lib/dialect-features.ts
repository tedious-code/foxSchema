/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Facade over `@foxschema/sql`'s dialect feature table — which controls an
 * engine can actually offer. Not a copy: the rules live in the package.
 */
export {
  dialectFeatures,
  supportsDialectFeature,
  dialectFeatureReason,
  schemaCompareBlocker,
  type DialectFeature,
  type FeatureSupport,
} from '@foxschema/ui-shared';
