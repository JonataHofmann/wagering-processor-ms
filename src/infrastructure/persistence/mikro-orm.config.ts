import { PERSISTENCE_SCHEMAS } from '@/src/infrastructure/persistence/schemas';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

const MIGRATIONS_PATH = 'src/infrastructure/persistence/migrations';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL,

  entities: PERSISTENCE_SCHEMAS,
  discovery: { warnWhenNoEntities: false },
  preferTs: true,
  forceUtcTimezone: true,

  // Pool de conexões. Ajustado de novo na etapa 13 (3 instâncias).
  pool: { min: 0, max: 20 },

  debug: process.env.MIKRO_ORM_DEBUG === 'true',

  extensions: [Migrator],
  migrations: {
    path: MIGRATIONS_PATH,
    pathTs: MIGRATIONS_PATH,
    glob: '!(*.d).{js,ts}',
    tableName: 'mikro_orm_migrations',

    transactional: true,
    allOrNothing: true,
    disableForeignKeys: false, // ver explicação abaixo
    snapshot: false,
    emit: 'ts',
  },
});
