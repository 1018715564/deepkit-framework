import {dirname, join} from "path";
import {appendFile, ensureDir, pathExists, readFile, remove, unlink, writeFile} from "fs-extra";
import {Exchange} from "./exchange";
import {uuid4Binary} from "@marcj/marshal-mongo";
import {Binary} from "bson";
import {ExchangeDatabase} from "./exchange-database";
import {File, FileMode, FilterQuery} from "@marcj/glut-core";
import {eachPair} from "@marcj/estdlib";
import * as crypto from "crypto";

export function getMd5(content: string | Buffer): string {
    const buffer: Buffer = 'string' === typeof content ? new Buffer(content, 'utf8') : new Buffer(content);
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');

    if (!md5) {
        throw new Error(`md5 is empty`);
    }

    return md5;
}


export interface FileMetaData {
    [k: string]: any;
}

export class FS {
    constructor(
        private exchange: Exchange,
        private database: ExchangeDatabase,
        private fileDir: string /* .glut/data/files/ */,
    ) {
    }

    public setFileDir(dir: string) {
        this.fileDir = dir;
    }

    public async removeAll(filter: FilterQuery<File>): Promise<boolean> {
        const files = await this.database.find(File, filter);
        return this.removeFiles(files);
    }

    public async remove(path: string, filter: FilterQuery<File>): Promise<boolean> {
        const file = await this.findOne(path, filter);
        if (file) {
            return this.removeFile(file);
        }

        return false;
    }

    public async removeFile(file: File): Promise<boolean> {
        return this.removeFiles([file]);
    }

    public async removeFiles(files: File[]): Promise<boolean> {
        const md5ToCheckMap: { [k: string]: number } = {};
        const fileIds: string[] = [];

        for (const file of files) {
            if (file.md5) {
                //we need to check whether the file is used by others
                md5ToCheckMap[file.md5] = 0;
            } else {
                const split = this.getIdSplit(file.id);
                const localPath = join(this.fileDir, 'streaming', split);
                await remove(localPath);
            }

            fileIds.push(file.id);

            this.exchange.publishFile(file.id, {
                type: 'remove',
                path: file.path
            });
        }

        await this.database.deleteMany(File, {
            $and: [{
                id: {$in: fileIds}
            }]
        });

        //found which md5s are still linked
        const fileCollection = await this.database.collection(File);
        const foundMd5s = await fileCollection.find({
            md5: {$in: Object.keys(md5ToCheckMap)}
        }, {
            projection: {md5: 1}
        }).toArray();

        //iterate over still linked md5 files, and remove missing ones
        for (const row of foundMd5s) {
            if (row.md5) {
                md5ToCheckMap[row.md5]++;
            }
        }

        const deletes: Promise<any>[] = [];
        for (const [k, v] of eachPair(md5ToCheckMap)) {
            if (v === 0) {
                //no link for that md5 left, so delete file locally
                const localPath = this.getLocalPathForMd5(k);
                deletes.push(remove(localPath));
            }
        }

        //delete them parallel
        await Promise.all(deletes);

        return true;
    }

    public async ls(filter: FilterQuery<File>): Promise<File[]> {
        return await this.database.find(File, filter);
    }

    public async findOne(path: string, filter?: FilterQuery<File>): Promise<File | null> {
        return await this.database.get(File, {...filter, path});
    }

    public async registerFile(md5: string, path: string, metaData?: FileMetaData): Promise<File> {
        const file = await this.database.get(File, {md5: md5});

        if (!file || !file.md5) {
            throw new Error(`File with md5 '${md5}' not found.`);
        }

        const localPath = this.getLocalPathForMd5(file.md5);

        if (await pathExists(localPath)) {
            const newFile = file.fork(path);
            newFile.meta = metaData;
            await this.database.add(File, newFile);
            return newFile;
        } else {
            throw new Error(`File with md5 '${md5}' not found (content deleted).`);
        }
    }

    public async hasMd5InDb(md5: string): Promise<boolean> {
        const collection = await this.database.collection(File);
        return 0 < await collection.countDocuments({md5: md5});
    }

    public async hasMd5(md5: string) {
        const file = await this.database.get(File, {md5: md5});

        if (file && file.md5) {
            const localPath = this.getLocalPathForMd5(md5);
            return await pathExists(localPath);
        }

        return false;
    }

    public async read(path: string, filter?: FilterQuery<File>): Promise<Buffer | undefined> {
        const file = await this.findOne(path, filter);
        // console.log('Read file ' + path, filter, file ? file.id : undefined);

        if (!file) {
            return;
        }

        return new Promise<Buffer>(async (resolve, reject) => {
            const localPath = this.getLocalPath(file);
            if (await pathExists(localPath)) {
                readFile(localPath, (err, data: Buffer) => {
                    if (err) {
                        reject(err);
                    }
                    // console.log('Read file content', data);
                    resolve(data);
                });
            } else {
                console.error('path does not exist', localPath);
                resolve();
            }
        });
    }

    public getMd5Split(md5: string) {
        return md5.substr(0, 2) + '/' + md5.substr(2, 2) + '/' + md5.substr(4);
    }

    public getIdSplit(id: string) {
        return id.substr(0, 8) + '/' + id.substr(9, 9) + '/' + id.substr(19);
    }

    public getLocalPathForMd5(md5: string): string {
        return join(this.fileDir, 'closed', this.getMd5Split(md5));
    }

    public getLocalPath(file: File) {
        if (file.mode === FileMode.closed) {
            if (!file.md5) {
                throw new Error(`Closed file has no md5 value: ${file.id} ${file.path}`);
            }
            return this.getLocalPathForMd5(file.md5);
        }

        if (!file.id) {
            throw new Error(`File has no id ${file.path}`);
        }

        return join(this.fileDir, 'streaming', this.getIdSplit(file.id));
    }

    /**
     * Adds a new file or updates an existing one.
     */
    public async write(path: string, data: string | Buffer, metaData?: FileMetaData): Promise<File> {
        let file = await this.findOne(path, metaData ? {meta: metaData} : {});

        if ('string' === typeof data) {
            data = Buffer.from(data, 'utf8');
        }

        if (file && !file.id) {
            throw new Error(`File has no id ${path} from DB`);
        }

        const md5 = getMd5(data);

        if (!file) {
            file = new File(path);
            file.meta = metaData;
            file.md5 = getMd5(data);
            file.size = data.byteLength;
            await this.database.add(File, file);
        } else {
            if (file.md5 && file.md5 !== md5) {
                const oldMd5 = file.md5;

                file.md5 = md5;
                file.size = data.byteLength;

                await this.database.patch(File, file.id, {md5: file.md5, size: file.size});

                //we need to check whether the local file needs to be removed
                if (!await this.hasMd5InDb(oldMd5)) {
                    //there's no db-file anymore linking using this local file, so remove it
                    const localPath = this.getLocalPathForMd5(oldMd5);
                    if (await pathExists(localPath)) {
                        await unlink(localPath);
                    }
                }
            }
        }

        const localPath = this.getLocalPath(file);
        const localDir = dirname(localPath);
        await ensureDir(localDir);
        await writeFile(localPath, data);

        this.exchange.publishFile(file.id, {
            type: 'set',
            path: path,
            content: data.toString('utf8')
        });

        return file;
    }

    /**
     * Streams content by always appending data to the file's content.
     */
    public async stream(path: string, data: Buffer, metaData?: FileMetaData) {
        let file = await this.findOne(path, metaData ? {meta: metaData} : {});

        if (!file) {
            file = new File(path);
            file.mode = FileMode.streaming;
            file.meta = metaData;
            await this.database.add(File, file);
        }

        const localPath = this.getLocalPath(file);
        const localDir = dirname(localPath);
        await ensureDir(localDir);

        await appendFile(localPath, data);

        this.exchange.publishFile(file.id, {
            type: 'append',
            path: path,
            content: data.toString(),
        });
    }
}
