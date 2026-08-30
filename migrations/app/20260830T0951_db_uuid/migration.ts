#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/505d4635a0e12bda8fcf2ec1b431502475aa102f65f1a6d172c5634365bece00/contract';
import endContract from '../../snapshots/505d4635a0e12bda8fcf2ec1b431502475aa102f65f1a6d172c5634365bece00/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/c5e272431b2f5c969a4037f84df5e74e211336c80ccce04338ab0b95eef9bb62/contract';
import startContract from '../../snapshots/c5e272431b2f5c969a4037f84df5e74e211336c80ccce04338ab0b95eef9bb62/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.setDefault({
        schema: 'public',
        table: 'generation',
        column: 'id',
        defaultSql: 'DEFAULT (gen_random_uuid())',
      }),
      this.setDefault({
        schema: 'public',
        table: 'voice',
        column: 'id',
        defaultSql: 'DEFAULT (gen_random_uuid())',
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
