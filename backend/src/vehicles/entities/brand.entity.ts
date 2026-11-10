import {
    Column,
    Entity,
    PrimaryColumn,
} from 'typeorm';

// Cette entité représente une marque automobile.
// Exemple : Porsche, Ferrari ou Rolls-Royce.

@Entity('brands')
export class Brand {
    // Identifiant généré automatiquement par PostgreSQL.
    @PrimaryColumn({
        type: 'uuid',
        default: () => 'gen_random_uuid()',
    })
    id!: string;

    // Nom de la marque.
    @Column({
        type: 'varchar',
    })
    name!: string;

    // URL ou chemin du logo officiel de la marque (ex. /brands/ferrari-logo.svg)
    @Column({
        name: 'logo_url',
        type: 'varchar',
        nullable: true,
    })
    logoUrl!: string | null;
}
