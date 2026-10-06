/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * How each object type is shown: icon, plural label, colour and group order.
 */
import React from 'react';
import { Box, Eye, FunctionSquare, Hash, Layers, SquareTerminal, Table2, Users, Zap } from 'lucide-react';
import type { DbObjectType } from '@/shared/lib/types';

export interface TypeMeta {
  icon: React.ReactElement;
  group: string;
  color: string;
}

/**
 * Icon, plural label and colour per object type.
 *
 * Exported because `TopToolbar` renders the same pills with counts — that bar
 * has the horizontal room this panel's narrow, resizable width does not. In
 * its own module so the always-loaded toolbar does not carry the whole tree.
 */
export const TYPE_META: Record<DbObjectType, TypeMeta> = {
  TABLE: { icon: <Table2 className="w-3.5 h-3.5 text-cyan-400" />, group: 'Tables', color: 'text-cyan-400' },
  MQT: { icon: <Layers className="w-3.5 h-3.5 text-teal-400" />, group: 'MQTs', color: 'text-teal-400' },
  VIEW: { icon: <Eye className="w-3.5 h-3.5 text-purple-400" />, group: 'Views', color: 'text-purple-400' },
  FUNCTION: {
    icon: <FunctionSquare className="w-3.5 h-3.5 text-amber-400" />,
    group: 'Functions',
    color: 'text-amber-400',
  },
  PROCEDURE: {
    icon: <SquareTerminal className="w-3.5 h-3.5 text-orange-400" />,
    group: 'Procedures',
    color: 'text-orange-400',
  },
  TRIGGER: { icon: <Zap className="w-3.5 h-3.5 text-rose-400" />, group: 'Triggers', color: 'text-rose-400' },
  SEQUENCE: { icon: <Hash className="w-3.5 h-3.5 text-sky-400" />, group: 'Sequences', color: 'text-sky-400' },
  TYPE: { icon: <Box className="w-3.5 h-3.5 text-indigo-400" />, group: 'Types', color: 'text-indigo-400' },
  ROLE: { icon: <Users className="w-3.5 h-3.5 text-pink-400" />, group: 'Roles', color: 'text-pink-400' },
};

/** Display order of the groups. Tables first — that is what people look for. */
export const TYPE_ORDER: DbObjectType[] = [
  'TABLE',
  'MQT',
  'VIEW',
  'FUNCTION',
  'PROCEDURE',
  'TRIGGER',
  'SEQUENCE',
  'TYPE',
  'ROLE',
];
