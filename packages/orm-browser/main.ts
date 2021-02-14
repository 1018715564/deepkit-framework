#!/usr/bin/env ts-node-script

import 'reflect-metadata';
import { OrmBrowserController } from '@deepkit/framework';
import { isAbsolute, join } from 'path';
import { Database } from '@deepkit/orm';
import { Application, createModule, KernelModule, registerStaticHttpController } from '@deepkit/framework';

Database.registry = [];

for (const path of process.argv.slice(2)) {
    require(isAbsolute(path) ? path : join(process.cwd(), path));
}

for (const db of Database.registry) {
    console.log(`Found database ${db.name} with adapter ${db.adapter.getName()}`);
}

Application.create(createModule({
    providers: [
        {provide: OrmBrowserController, useValue: new OrmBrowserController(Database.registry)},
    ],
    controllers: [
        OrmBrowserController
    ],
    imports: [
        KernelModule.configure({
            port: 9090,
            broker: {
                startOnBootstrap: false,
            }
        })
    ]
}).setup((module, config) => {
    const localPathPrefix = __dirname.includes('orm-browser/dist') ? '../../' : './';
    const localPath = join(__dirname, localPathPrefix, 'node_modules/@deepkit/orm-browser-gui/dist/orm-browser-gui');
    registerStaticHttpController(module, '/', localPath);
})).run(['server:listen']);