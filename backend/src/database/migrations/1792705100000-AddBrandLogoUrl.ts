import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddBrandLogoUrl1792705100000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasColumn = await queryRunner.hasColumn('brands', 'logo_url');
        if (!hasColumn) {
            await queryRunner.addColumn(
                'brands',
                new TableColumn({
                    name: 'logo_url',
                    type: 'varchar',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const hasColumn = await queryRunner.hasColumn('brands', 'logo_url');
        if (hasColumn) {
            await queryRunner.dropColumn('brands', 'logo_url');
        }
    }
}
