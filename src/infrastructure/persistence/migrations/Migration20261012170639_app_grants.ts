import { Migration } from '@mikro-orm/migrations';

export class Migration20261012170639_app_grants extends Migration {
  override name = 'Migration20261012170639_app_grants';

  override async up(): Promise<void> {
    // permite "enxergar" objetos dentro do schema public (não dá acesso às tabelas em si)
    this.addSql(`GRANT USAGE ON SCHEMA public TO wagering_app`);

    // tabelas operacionais: ler, inserir e atualizar; nunca apagar
    this.addSql(
      `GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, inbox_messages TO wagering_app`,
    );

    // outbox: também apagar (limpeza de eventos já publicados)
    this.addSql(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_messages TO wagering_app`,
    );

    // ledger: só ler e inserir
    this.addSql(
      `GRANT SELECT, INSERT ON wallet_ledger_entries TO wagering_app`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `REVOKE ALL ON wallets, wager_transactions, inbox_messages, outbox_messages, wallet_ledger_entries FROM wagering_app`,
    );
    this.addSql(`REVOKE USAGE ON SCHEMA public FROM wagering_app`);
  }
}
