const { Pool } = require('pg');
const { PrepareEstimateUseCase } = require('../../dist/src/application/usecases/prepare-estimate.usecase');

// Isolated demo order references: these do not create or change Service Orders.
const estimates = [
  {
    "id": "00000000-0000-4000-8000-000000000001",
    "body": {
      "ordemServicoId": "000000000000000000000001",
      "valorTotal": 365,
      "pecas": [
        {
          "id": "00000000000000000000a001",
          "nome": "Óleo de motor 5W30",
          "descricao": "Óleo sintético para motor, 1 litro",
          "tipo": "INSUMO",
          "preco": 45,
          "quantidade": 4
        },
        {
          "id": "00000000000000000000a002",
          "nome": "Filtro de óleo",
          "descricao": "Filtro de óleo do motor",
          "tipo": "PECA",
          "preco": 35,
          "quantidade": 1
        }
      ],
      "servicos": [
        {
          "id": "00000000000000000000b001",
          "nome": "Troca de óleo",
          "descricao": "Substituição do óleo e filtro do motor",
          "preco": 150
        }
      ]
    }
  },
  {
    "id": "00000000-0000-4000-8000-000000000002",
    "body": {
      "ordemServicoId": "000000000000000000000002",
      "valorTotal": 400,
      "pecas": [
        {
          "id": "00000000000000000000a003",
          "nome": "Pastilhas de freio",
          "descricao": "Jogo de pastilhas de freio dianteiras",
          "tipo": "PECA",
          "preco": 220,
          "quantidade": 1
        }
      ],
      "servicos": [
        {
          "id": "00000000000000000000b002",
          "nome": "Troca de pastilhas",
          "descricao": "Substituição das pastilhas de freio dianteiras",
          "preco": 180
        }
      ]
    }
  }
];

async function seedDatabase(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('billing:development-seed',0))");
    for (const { id, body } of estimates) {
      const { input, hash } = new PrepareEstimateUseCase().execute(body);
      await client.query(`INSERT INTO estimates
        (id,order_id,version,request_hash,status,total_cents,items,expires_at)
        VALUES($1,$2,1,$3,'PENDING',$4,$5,now()+interval '7 days')
        ON CONFLICT DO NOTHING`, [id,input.orderId,hash,input.total,JSON.stringify(input.items)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runSeed() {
  if (process.env.SEED_ENABLED === 'false') return;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await seedDatabase(pool);
    console.log('Billing seed complete: two pending demo estimates.');
  } finally {
    await pool.end();
  }
}

module.exports = { seedDatabase };
if (require.main === module) runSeed().catch(error => { console.error('Billing seed failed:', error.message); process.exitCode = 1; });
