/*
 * Deepkit Framework
 * Copyright (C) 2021 Deepkit UG, Marc J. Schmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * You should have received a copy of the MIT License along with this program.
 */

import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { BenchSuite } from '../../../bench';

const prisma = new PrismaClient();

export async function main() {
    const count = 10_000;

    let created = false;
    for (let i = 0; i < 5; i++) {
        console.log('round', i);
        const bench = new BenchSuite('prisma');

        if (!created) {
            created = true;
            await prisma.model.deleteMany({});
            await bench.runAsyncFix(1, 'insert', async () => {
                for (let i = 1; i <= count; i++) {
                    await prisma.model.create({
                        data: {
                            username: 'Peter ' + i,
                            tags: 'a,b,c',
                            priority: 5,
                            ready: true,
                        }
                    });
                }
            });
        }

        await bench.runAsyncFix(10, 'fetch', async () => {
            const users = await prisma.model.findMany();
        });

        await bench.runAsyncFix(100, 'fetch-1', async () => {
            const user = await prisma.model.findFirst();
        });

        // const dbItems = await session.query(DeepkitModel).find();
        // for (const item of dbItems) {
        //     item.priority++;
        // }
        //
        // await bench.runAsyncFix(1, 'update', async () => {
        //     await session.commit();
        // });
        //
        // await bench.runAsyncFix(1, 'remove', async () => {
        //     for (const item of dbItems) {
        //         session.remove(item);
        //     }
        //
        //     await session.commit();
        // });
    }

    prisma.$disconnect();
}
