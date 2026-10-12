
### usuario do banco tem permissão de update ou delete somente em tabelas especificas
"o ledger não pode ser alterado nem apagado"

### Porque CONSTRAINT uq_wallets_id_currency     UNIQUE (id, currency)?
Essa constraint parece redundante: id já é a chave primária, então o par (id, currency) é único de qualquer jeito. Ela existe por outro motivo. O Postgres só aceita uma foreign key que aponte para colunas com uma constraint UNIQUE (ou PRIMARY KEY) exatamente sobre elas. Ela é o alvo de uma FK composta no ledger.
O problema que isso evita
Com uma FK simples, só wallet_id → wallets(id), o banco aceitaria isto:
sql
-- wallet em BRL
INSERT INTO wallets (id, ..., currency, ...) VALUES ('w1', ..., 'BRL', ...);

-- lançamento em USD na wallet BRL: passaria com FK simples
INSERT INTO wallet_ledger_entries (wallet_id, currency, amount, ...) VALUES ('w1', 'USD', '10.00', ...);

Custo e alternativas
O custo é um índice a mais em wallets, pequeno, e que só é consultado quando um lançamento é inserido.

Havia duas alternativas, e preferi a FK composta a ambas:

Alternativa	Por que não
Não guardar currency no ledger (ler sempre da wallet)	O lançamento deixa de ser autossuficiente. Para reconstruir o Money de um lançamento ou auditar o ledger isoladamente, seria preciso um JOIN com wallets
Validar a moeda com trigger	Funciona, mas é código procedural para algo que uma FK resolve de forma declarativa, mais simples e mais rápida

A FK composta é a forma mais direta de dizer “esta coluna precisa ser igual à daquela linha”, e o UNIQUE (id, currency) é o pré-requisito técnico para ela existir.



# Documentar erros das triggers




