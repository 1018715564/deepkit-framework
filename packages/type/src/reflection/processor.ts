/*
 * Deepkit Framework
 * Copyright (c) Deepkit UG, Marc J. Schmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * You should have received a copy of the MIT License along with this program.
 */

import {
    Annotations,
    CartesianProduct,
    defaultAnnotation,
    flattenUnionTypes,
    indexAccess,
    isPrimitive,
    isType,
    isWithAnnotations,
    MappedModifier,
    merge,
    narrowOriginalLiteral,
    OuterType,
    ReflectionKind,
    ReflectionOp,
    ReflectionVisibility,
    Type,
    TypeClass,
    typeDecorators,
    TypeEnumMember,
    TypeIndexSignature,
    typeInfer,
    TypeInfer,
    TypeLiteral,
    TypeLiteralMember,
    TypeMethodSignature,
    TypeObjectLiteral,
    TypeParameter,
    TypeProperty,
    TypePropertySignature,
    TypeTemplateLiteral,
    TypeTupleMember,
    TypeUnion,
    unboxUnion
} from './type';
import { isExtendable } from './extends';
import { ClassType, isArray, isFunction } from '@deepkit/core';

export type RuntimeStackEntry = Type | Object | (() => ClassType | Object) | string | number | boolean | bigint;

export type Packed = (RuntimeStackEntry | string)[] & { __is?: (data: any) => boolean } & { __type?: OuterType };

export class PackStruct {
    constructor(
        public ops: ReflectionOp[] = [],
        public stack: RuntimeStackEntry[] = [],
    ) {
    }
}

function unpackOps(decodedOps: ReflectionOp[], encodedOPs: string): void {
    for (let i = 0; i < encodedOPs.length; i++) {
        decodedOps.push(encodedOPs.charCodeAt(i) - 33);
    }
}

export function unpack(pack: Packed): PackStruct {
    const ops: ReflectionOp[] = [];
    const stack: RuntimeStackEntry[] = [];

    const encodedOPs = pack[pack.length - 1];

    //the end has always to be a string
    if ('string' !== typeof encodedOPs) return { ops: [], stack: [] };

    if (pack.length > 1) {
        stack.push(...pack.slice(0, -1) as RuntimeStackEntry[]);
    }

    unpackOps(ops, encodedOPs);

    return { ops, stack };
}

function newArray<T>(init: T, items: number): T[] {
    const a: T[] = [];
    for (let i = 0; i < items; i++) {
        a.push(init);
    }
    return a;
}

export function resolvePacked(type: Packed, args: any[] = []): OuterType {
    return resolveRuntimeType(type, args) as OuterType;
}

function isPack(o: any): o is Packed {
    return isArray(o);
}

export function resolveRuntimeType(o: any, args: any[] = [], registry?: ProcessorRegistry): Type {
    const p: Packed = isArray(o) ? o : o.__type;
    if (isPack(o) && o.__type) return o.__type;
    if (registry) {
        const existing = registry.get(p);
        if (existing) {
            return existing.resultType;
        }
    }

    const packStruct = unpack(p);
    if (!packStruct) {
        throw new Error('No valid runtime type given. Is @deepkit/type correctly installed? Execute deepkit-type-install to check');
    }

    const processor = new Processor(p, registry);
    if (registry) registry.register(p, processor);
    // debugPackStruct(pack);
    const type = processor.run(packStruct.ops, packStruct.stack, args);
    if (registry) registry.delete(p);
    if (isType(type)) {
        if (isPack(o)) o.__type = type as OuterType;

        if (!isPack(o)) {
            if (type.kind === ReflectionKind.class && type.classType === Object) {
                type.classType = o;
            }
            if (type.kind === ReflectionKind.function && !type.function) {
                type.function = o;
            }
        }
        return type;
    }

    throw new Error('No type returned from runtime type program');
}

interface Frame {
    index: number;
    startIndex: number; //when the frame started, index of the stack
    variables: number;
    inputs: RuntimeStackEntry[];
    previous?: Frame;
    mappedType?: Loop;
    distributiveLoop?: Loop;
}

class Loop {
    private types: Type[] = [];
    private i: number = 0;

    constructor(private fromType: Type) {
        if (fromType.kind === ReflectionKind.union) {
            this.types = fromType.types;
        } else {
            this.types = [fromType];
        }
    }

    next(): Type | undefined {
        return this.types[this.i++];
    }
}

/**
 * To track circular types the registry stores for each Packed a created Processor and returns its `resultType` when it was already registered.
 */
export class ProcessorRegistry {
    protected registry = new Map<Packed, Processor>();

    get(t: Packed): Processor | undefined {
        return this.registry.get(t);
    }

    register(t: Packed, processor: Processor) {
        this.registry.set(t, processor);
    }

    delete(t: Packed) {
        this.registry.delete(t);
    }
}

export class Processor {
    stack: (RuntimeStackEntry | Type)[] = newArray({ kind: ReflectionKind.never }, 128);
    stackPointer = -1; //pointer to the stack
    frame: Frame = { index: 0, startIndex: -1, inputs: [], variables: 0 };
    program: number = 0;

    resultType: Type = { kind: ReflectionKind.any };

    constructor(public forType: Packed, protected registry: ProcessorRegistry = new ProcessorRegistry) {
    }

    run(ops: ReflectionOp[], initialStack: RuntimeStackEntry[], initialInputs: RuntimeStackEntry[] = []): Type | RuntimeStackEntry {
        // if (ops.length === 1 && ops[0] === ReflectionOp.string) return { kind: ReflectionKind.string };

        for (let i = 0; i < initialStack.length; i++) {
            this.stack[i] = initialStack[i];
        }

        // this.resultType = {kind: ReflectionKind.any};
        this.stackPointer = initialStack.length - 1;
        this.frame.startIndex = this.stackPointer;
        this.frame.previous = undefined;
        this.frame.variables = 0;
        this.frame.inputs = initialInputs;

        const s = ops.length;
        for (this.program = 0; this.program < s; this.program++) {
            const op = ops[this.program];
            // process.stdout.write(`[${this.frame.index}] step ${this.program} ${ReflectionOp[op]}\n`);
            switch (op) {
                case ReflectionOp.string:
                    this.pushType({ kind: ReflectionKind.string });
                    break;
                case ReflectionOp.number:
                    this.pushType({ kind: ReflectionKind.number });
                    break;
                case ReflectionOp.numberBrand:
                    const ref = this.eatParameter(ops) as number;
                    this.pushType({ kind: ReflectionKind.number, brand: ref });
                    break;
                case ReflectionOp.boolean:
                    this.pushType({ kind: ReflectionKind.boolean });
                    break;
                case ReflectionOp.void:
                    this.pushType({ kind: ReflectionKind.void });
                    break;
                case ReflectionOp.unknown:
                    this.pushType({ kind: ReflectionKind.unknown });
                    break;
                case ReflectionOp.object:
                    this.pushType({ kind: ReflectionKind.object });
                    break;
                case ReflectionOp.never:
                    this.pushType({ kind: ReflectionKind.never });
                    break;
                case ReflectionOp.undefined:
                    this.pushType({ kind: ReflectionKind.undefined });
                    break;
                case ReflectionOp.bigint:
                    this.pushType({ kind: ReflectionKind.bigint });
                    break;
                case ReflectionOp.symbol:
                    this.pushType({ kind: ReflectionKind.symbol });
                    break;
                case ReflectionOp.null:
                    this.pushType({ kind: ReflectionKind.null });
                    break;
                case ReflectionOp.any:
                    this.pushType({ kind: ReflectionKind.any });
                    break;
                case ReflectionOp.literal: {
                    const ref = this.eatParameter(ops) as number;
                    this.pushType({ kind: ReflectionKind.literal, literal: initialStack[ref] as string | number | boolean | bigint });
                    break;
                }
                case ReflectionOp.templateLiteral: {
                    const types = this.popFrame() as Type[];
                    const result: TypeUnion = { kind: ReflectionKind.union, types: [] };
                    // const templateLiteral: TypeTemplateLiteral = { kind: ReflectionKind.templateLiteral, types: [] };
                    const cartesian = new CartesianProduct();
                    for (const type of types) {
                        cartesian.add(type);
                    }
                    const product = cartesian.calculate();

                    for (const combination of product) {
                        const template: TypeTemplateLiteral = { kind: ReflectionKind.templateLiteral, types: [] };
                        let hasPlaceholder = false;
                        let lastLiteral: { kind: ReflectionKind.literal, literal: string } | undefined = undefined;
                        //merge a combination of types, e.g. [string, 'abc', '3'] as template literal => `${string}abc3`.
                        for (const item of combination) {
                            if (item.kind === ReflectionKind.literal) {
                                if (lastLiteral) {
                                    lastLiteral.literal += item.literal as string + '';
                                } else {
                                    lastLiteral = { kind: ReflectionKind.literal, literal: item.literal as string + '' };
                                    template.types.push(lastLiteral);
                                }
                            } else {
                                hasPlaceholder = true;
                                lastLiteral = undefined;
                                template.types.push(item as TypeTemplateLiteral['types'][number]);
                            }
                        }

                        if (hasPlaceholder) {
                            if (template.types.length === 1 && template.types[0].kind === ReflectionKind.string) {
                                result.types.push(template.types[0]);
                            } else {
                                result.types.push(template);
                            }
                        } else if (lastLiteral) {
                            result.types.push(lastLiteral);
                        }
                    }
                    this.pushType(unboxUnion(result));
                    break;
                }
                case ReflectionOp.date:
                    this.pushType({ kind: ReflectionKind.class, classType: Date, types: [] });
                    break;
                case ReflectionOp.uint8Array:
                    this.pushType({ kind: ReflectionKind.class, classType: Uint8Array, types: [] });
                    break;
                case ReflectionOp.int8Array:
                    this.pushType({ kind: ReflectionKind.class, classType: Int8Array, types: [] });
                    break;
                case ReflectionOp.uint8ClampedArray:
                    this.pushType({ kind: ReflectionKind.class, classType: Uint8ClampedArray, types: [] });
                    break;
                case ReflectionOp.uint16Array:
                    this.pushType({ kind: ReflectionKind.class, classType: Uint16Array, types: [] });
                    break;
                case ReflectionOp.int16Array:
                    this.pushType({ kind: ReflectionKind.class, classType: Int16Array, types: [] });
                    break;
                case ReflectionOp.uint32Array:
                    this.pushType({ kind: ReflectionKind.class, classType: Uint32Array, types: [] });
                    break;
                case ReflectionOp.int32Array:
                    this.pushType({ kind: ReflectionKind.class, classType: Int32Array, types: [] });
                    break;
                case ReflectionOp.float32Array:
                    this.pushType({ kind: ReflectionKind.class, classType: Float32Array, types: [] });
                    break;
                case ReflectionOp.float64Array:
                    this.pushType({ kind: ReflectionKind.class, classType: Float64Array, types: [] });
                    break;
                case ReflectionOp.bigInt64Array:
                    this.pushType({
                        kind: ReflectionKind.class,
                        classType: 'undefined' !== typeof BigInt64Array ? BigInt64Array : class BigInt64ArrayNotAvailable {
                        },
                        types: []
                    });
                    break;
                case ReflectionOp.arrayBuffer:
                    this.pushType({ kind: ReflectionKind.class, classType: ArrayBuffer, types: [] });
                    break;
                case ReflectionOp.class: {
                    const types = this.popFrame() as Type[];
                    for (const member of types) {
                        if (member.kind === ReflectionKind.method && member.name === 'constructor') {
                            for (const parameter of member.parameters) {
                                if (parameter.visibility !== undefined) {
                                    const property = {
                                        kind: ReflectionKind.property,
                                        name: parameter.name,
                                        visibility: parameter.visibility,
                                        type: parameter.type,
                                    } as TypeProperty;
                                    if (parameter.optional) property.optional = true;
                                    if (parameter.readonly) property.readonly = true;
                                    types.push(property);
                                }
                            }
                            break;
                        }
                        // if (member.kind === ReflectionKind.property) member.type = widenLiteral(member.type);
                    }
                    const args = this.frame.inputs.filter(isType);
                    let t = { kind: ReflectionKind.class, classType: Object, types } as TypeClass;

                    //only for the very last op do we replace this.resultType. Otherwise objectLiteral in between would overwrite it.
                    if (this.program + 1 === s) t = Object.assign(this.resultType, t);
                    if (args.length) t.arguments = args;
                    this.pushType(t);
                    break;
                }
                case ReflectionOp.parameter: {
                    const ref = this.eatParameter(ops) as number;
                    this.pushType({ kind: ReflectionKind.parameter, name: initialStack[ref] as string, type: this.pop() as Type });
                    break;
                }
                case ReflectionOp.classReference: {
                    const ref = this.eatParameter(ops) as number;
                    const classType = (initialStack[ref] as Function)();
                    const args = this.popFrame() as Type[];
                    if ('__type' in classType) {
                        this.pushType(resolveRuntimeType(classType, args, this.registry));
                    } else {
                        this.pushType({ kind: ReflectionKind.class, classType: classType, arguments: args, types: [] });
                    }
                    break;
                }
                case ReflectionOp.enum: {
                    const types = this.popFrame() as TypeEnumMember[];
                    const enumType: { [name: string]: string | number } = {};

                    let i = 0;
                    for (const type of types) {
                        if (type.default) {
                            const v = type.default();
                            enumType[type.name] = v;
                            if ('number' === typeof v) {
                                i = v + 1;
                            }
                        } else {
                            enumType[type.name] = i++;
                        }
                    }
                    this.pushType({ kind: ReflectionKind.enum, enum: enumType, values: Object.values(enumType) });
                    break;
                }
                case ReflectionOp.enumMember: {
                    const name = initialStack[this.eatParameter(ops) as number] as string | (() => string);
                    this.pushType({
                        kind: ReflectionKind.enumMember,
                        name: isFunction(name) ? name() : name
                    });
                    break;
                }
                case ReflectionOp.tuple: {
                    const types: TypeTupleMember[] = [];
                    const stackTypes = this.popFrame() as Type[];
                    for (const type of stackTypes) {
                        let resolved: TypeTupleMember = type.kind === ReflectionKind.tupleMember ? type : { kind: ReflectionKind.tupleMember, type };
                        if (resolved.type.kind === ReflectionKind.rest) {
                            if (resolved.type.type.kind === ReflectionKind.tuple) {
                                for (const sub of resolved.type.type.types) {
                                    types.push(sub);
                                }
                            } else {
                                types.push(resolved);
                            }
                        } else {
                            types.push(resolved);
                        }
                    }
                    this.pushType({ kind: ReflectionKind.tuple, types });
                    break;
                }
                case ReflectionOp.tupleMember: {
                    this.pushType({
                        kind: ReflectionKind.tupleMember, type: this.pop() as Type,
                    });
                    break;
                }
                case ReflectionOp.namedTupleMember: {
                    const name = initialStack[this.eatParameter(ops) as number] as string;
                    this.pushType({
                        kind: ReflectionKind.tupleMember, type: this.pop() as Type,
                        name: isFunction(name) ? name() : name
                    });
                    break;
                }
                case ReflectionOp.rest: {
                    this.pushType({
                        kind: ReflectionKind.rest,
                        type: this.pop() as Type,
                    });
                    break;
                }
                case ReflectionOp.regexp: {
                    this.pushType({ kind: ReflectionKind.regexp });
                    break;
                }
                case ReflectionOp.typeParameter:
                case ReflectionOp.typeParameterDefault: {
                    const nameRef = this.eatParameter(ops) as number;
                    let type = this.frame.inputs[this.frame.variables++];

                    if (op === ReflectionOp.typeParameterDefault) {
                        const defaultValue = this.pop();
                        if (type === undefined) {
                            type = defaultValue;
                        }
                    }

                    if (type === undefined) {
                        //generic not instantiated
                        this.pushType({ kind: ReflectionKind.typeParameter, name: initialStack[nameRef] as string });
                    } else {
                        this.pushType(type as Type);
                    }
                    break;
                }
                case ReflectionOp.set:
                    this.pushType({ kind: ReflectionKind.class, classType: Set, arguments: [this.pop() as Type], types: [] });
                    break;
                case ReflectionOp.map:
                    const value = this.pop() as Type;
                    const key = this.pop() as Type;
                    this.pushType({ kind: ReflectionKind.class, classType: Map, arguments: [key, value], types: [] });
                    break;
                case ReflectionOp.promise:
                    this.pushType({ kind: ReflectionKind.promise, type: this.pop() as Type });
                    break;
                case ReflectionOp.union: {
                    const types = this.popFrame() as Type[];
                    this.pushType(unboxUnion({ kind: ReflectionKind.union, types: flattenUnionTypes(types) }));
                    break;
                }
                case ReflectionOp.intersection: {
                    const types = this.popFrame() as Type[];
                    let primitive = undefined as Type | undefined;
                    const annotations: Annotations = {};
                    const decorators: OuterType[] = [];
                    const candidates: (TypeObjectLiteral | TypeClass)[] = [];

                    function extractTypes(types: Type[]) {
                        outer:
                            for (const type of types) {
                                if (type.kind === ReflectionKind.never) continue;

                                if (type.kind === ReflectionKind.intersection) {
                                    extractTypes(type.types);
                                    continue;
                                }
                                if (type.kind === ReflectionKind.objectLiteral) {
                                    for (const decorator of typeDecorators) {
                                        if (decorator(annotations, type)) {
                                            decorators.push(type);
                                            continue outer;
                                        }
                                    }
                                }

                                if (isPrimitive(type) || type.kind === ReflectionKind.array || type.kind === ReflectionKind.tuple || type.kind === ReflectionKind.regexp || type.kind === ReflectionKind.symbol) {
                                    //at the moment, we globally assume that people don't add types to array/tuple/regexp/symbols e.g. no `(string[] & {doSomething: () => void})`.
                                    //we treat all additional types in the intersection as decorators.
                                    primitive = type;
                                } else if (type.kind === ReflectionKind.objectLiteral || type.kind === ReflectionKind.class) {
                                    candidates.push(type);
                                }
                            }
                    }

                    extractTypes(types);

                    let result = undefined as Type | undefined;

                    if (primitive) {
                        result = primitive;
                        annotations[defaultAnnotation.symbol] = candidates;
                    } else {
                        if (candidates.length === 1) {
                            result = candidates[0];
                        } else {
                            const isMergeAble = candidates.every(v => v.kind === ReflectionKind.objectLiteral || v.kind === ReflectionKind.class);
                            if (isMergeAble) {
                                result = merge(candidates);
                            } else {
                                result = candidates[0];
                            }
                        }
                    }

                    if (result) {
                        if (isWithAnnotations(result)) {
                            result.annotations ||= {};
                            if (decorators.length) result.decorators = decorators;
                            Object.assign(result.annotations, annotations);
                        }
                        this.pushType(result);
                    } else {
                        this.pushType({ kind: ReflectionKind.never });
                    }
                    break;
                }
                case ReflectionOp.function: {
                    const types = this.popFrame() as TypeParameter[];
                    const name = initialStack[this.eatParameter(ops) as number] as string;
                    this.pushType({
                        kind: ReflectionKind.function,
                        name: name || undefined,
                        return: types.length > 0 ? types[types.length - 1] : { kind: ReflectionKind.any },
                        parameters: types.length > 1 ? types.slice(0, -1) : []
                    });
                    break;
                }
                case ReflectionOp.array:
                    this.pushType({ kind: ReflectionKind.array, type: this.pop() as Type });
                    break;
                case ReflectionOp.property:
                case ReflectionOp.propertySignature: {
                    const name = initialStack[this.eatParameter(ops) as number] as number | string | symbol | (() => symbol);
                    let type = this.pop() as Type;
                    let isOptional = false;

                    if (type.kind === ReflectionKind.union && type.types.length === 2) {
                        const undefinedType = type.types.find(v => v.kind === ReflectionKind.undefined);
                        const restType = type.types.find(v => v.kind !== ReflectionKind.null && v.kind !== ReflectionKind.undefined);
                        if (restType && undefinedType) {
                            type = restType;
                            isOptional = true;
                        }
                    }

                    const property = {
                        kind: op === ReflectionOp.propertySignature ? ReflectionKind.propertySignature : ReflectionKind.property,
                        type,
                        name: isFunction(name) ? name() : name
                    } as TypeProperty | TypePropertySignature;

                    if (isOptional) {
                        property.optional = true;
                    }

                    if (op === ReflectionOp.property) {
                        (property as TypeProperty).visibility = ReflectionVisibility.public;
                    }

                    this.pushType(property);
                    break;
                }
                case ReflectionOp.method:
                case ReflectionOp.methodSignature: {
                    const name = initialStack[this.eatParameter(ops) as number] as number | string | symbol;
                    const types = this.popFrame() as Type[];
                    const returnType: Type = types.length > 0 ? types[types.length - 1] : { kind: ReflectionKind.any };
                    const parameters: TypeParameter[] = types.length > 1 ? types.slice(0, -1) as TypeParameter[] : [];

                    if (op === ReflectionOp.method) {
                        this.pushType({ kind: ReflectionKind.method, visibility: ReflectionVisibility.public, name, return: returnType, parameters });
                    } else {
                        this.pushType({ kind: ReflectionKind.methodSignature, name, return: returnType, parameters });
                    }
                    break;
                }
                case ReflectionOp.optional:
                    (this.stack[this.stackPointer] as TypeLiteralMember | TypeTupleMember).optional = true;
                    break;
                case ReflectionOp.readonly:
                    (this.stack[this.stackPointer] as TypeLiteralMember).readonly = true;
                    break;
                case ReflectionOp.public:
                    (this.stack[this.stackPointer] as TypeLiteralMember).visibility = ReflectionVisibility.public;
                    break;
                case ReflectionOp.protected:
                    (this.stack[this.stackPointer] as TypeLiteralMember).visibility = ReflectionVisibility.protected;
                    break;
                case ReflectionOp.private:
                    (this.stack[this.stackPointer] as TypeLiteralMember).visibility = ReflectionVisibility.private;
                    break;
                case ReflectionOp.abstract:
                    (this.stack[this.stackPointer] as TypeLiteralMember).abstract = true;
                    break;
                case ReflectionOp.defaultValue:
                    (this.stack[this.stackPointer] as TypeProperty | TypeEnumMember).default = initialStack[this.eatParameter(ops) as number] as () => any;
                    break;
                case ReflectionOp.description:
                    (this.stack[this.stackPointer] as TypeProperty).description = initialStack[this.eatParameter(ops) as number] as string;
                    break;
                case ReflectionOp.indexSignature: {
                    const type = this.pop() as Type;
                    const index = this.pop() as Type;
                    this.pushType({
                        kind: ReflectionKind.indexSignature,
                        index, type
                    });
                    break;
                }
                case ReflectionOp.objectLiteral: {
                    const types = this.popFrame() as (TypeIndexSignature | TypePropertySignature | TypeMethodSignature)[];
                    // for (const member of types) {
                    //     if (member.kind === ReflectionKind.propertySignature) member.type = widenLiteral(member.type);
                    // }
                    let t = {
                        kind: ReflectionKind.objectLiteral,
                        types
                    } as TypeObjectLiteral;

                    //only for the very last op do we replace this.resultType. Otherwise, objectLiteral in between would overwrite it.
                    if (this.program + 1 === s) t = Object.assign(this.resultType, t);
                    this.pushType(t);
                    break;
                }
                // case ReflectionOp.pointer: {
                //     this.push(initialStack[this.eatParameter(ops) as number]);
                //     break;
                // }
                case ReflectionOp.distribute: {
                    const program = this.eatParameter(ops) as number;

                    if (this.frame.distributiveLoop) {
                        const type = this.pop() as Type;

                        if (type.kind === ReflectionKind.never) {
                            //we ignore never, to filter them out
                        } else {
                            this.push(type);
                        }
                    } else {
                        //start loop
                        const distributeOver = this.pop() as Type;
                        this.frame.distributiveLoop = new Loop(distributeOver);
                    }

                    const next = this.frame.distributiveLoop.next();
                    if (next === undefined) {
                        //end
                        const types = this.popFrame() as Type[];
                        const result: TypeUnion = { kind: ReflectionKind.union, types: flattenUnionTypes(types) };
                        this.push(unboxUnion(result));
                    } else {
                        this.stack[this.frame.startIndex + 1] = next;
                        this.call(program, -1); //-1=jump back to this very same position, to be able to loop
                    }

                    break;
                }
                case ReflectionOp.condition: {
                    const right = this.pop() as Type;
                    const left = this.pop() as Type;
                    const condition = this.pop() as number | boolean;
                    this.popFrame();
                    condition ? this.pushType(left) : this.pushType(right);
                    break;
                }
                case ReflectionOp.jumpCondition: {
                    const leftProgram = this.eatParameter(ops) as number;
                    const rightProgram = this.eatParameter(ops) as number;
                    const condition = this.pop() as number | boolean;
                    this.call(condition ? leftProgram : rightProgram);
                    break;
                }
                case ReflectionOp.infer: {
                    const frameOffset = this.eatParameter(ops) as number;
                    const stackEntryIndex = this.eatParameter(ops) as number;
                    const frame = this.frame;
                    this.push({
                        kind: ReflectionKind.infer, set: (type: Type) => {
                            if (frameOffset === 0) {
                                this.stack[frame.startIndex + 1 + stackEntryIndex] = type;
                            } else if (frameOffset === 1) {
                                this.stack[frame.previous!.startIndex + 1 + stackEntryIndex] = type;
                            } else if (frameOffset === 2) {
                                this.stack[frame.previous!.previous!.startIndex + 1 + stackEntryIndex] = type;
                            } else if (frameOffset === 3) {
                                this.stack[frame.previous!.previous!.previous!.startIndex + 1 + stackEntryIndex] = type;
                            } else if (frameOffset === 4) {
                                this.stack[frame.previous!.previous!.previous!.previous!.startIndex + 1 + stackEntryIndex] = type;
                            } else {
                                let current = frame;
                                for (let i = 0; i < frameOffset; i++) current = current.previous!;
                                this.stack[current.startIndex + 1 + stackEntryIndex] = type;
                            }
                        }
                    } as TypeInfer);
                    break;
                }
                case ReflectionOp.extends: {
                    const right = this.pop() as string | number | boolean | Type;
                    const left = this.pop() as string | number | boolean | Type;
                    this.push(isExtendable(left, right));
                    break;
                }
                case ReflectionOp.indexAccess: {
                    let right = this.pop() as Type;
                    const left = this.pop() as Type;

                    if (!isType(left)) {
                        this.push({ kind: ReflectionKind.never });
                        break;
                    }

                    this.push(indexAccess(left, right));
                    break;
                }
                case ReflectionOp.typeof: {
                    const param1 = this.eatParameter(ops) as number;
                    const fn = initialStack[param1] as () => any;
                    const value = fn();
                    this.pushType(typeInfer(value, this.registry));
                    break;
                }
                case ReflectionOp.keyof: {
                    const type = this.pop() as Type;
                    const union = { kind: ReflectionKind.union, types: [] } as TypeUnion;
                    this.push(union);
                    if (type.kind === ReflectionKind.objectLiteral || type.kind === ReflectionKind.class) {
                        for (const member of type.types) {
                            if (member.kind === ReflectionKind.propertySignature || member.kind === ReflectionKind.property) {
                                union.types.push({ kind: ReflectionKind.literal, literal: member.name } as TypeLiteral);
                            } else if (member.kind === ReflectionKind.methodSignature || member.kind === ReflectionKind.method) {
                                union.types.push({ kind: ReflectionKind.literal, literal: member.name } as TypeLiteral);
                            }
                        }
                    }
                    break;
                }
                case ReflectionOp.var: {
                    this.push({ kind: ReflectionKind.never });
                    this.frame.variables++;
                    break;
                }
                case ReflectionOp.mappedType: {
                    const functionPointer = this.eatParameter(ops) as number;
                    const modifier = this.eatParameter(ops) as number;

                    if (this.frame.mappedType) {
                        const type = this.pop() as Type;
                        let index: Type | string | boolean | symbol | number | bigint = this.stack[this.frame.startIndex + 1] as Type;

                        if (index.kind === ReflectionKind.string || index.kind === ReflectionKind.number || index.kind === ReflectionKind.symbol) {
                            this.push({ kind: ReflectionKind.indexSignature, type, index });
                        } else {
                            if (index.kind === ReflectionKind.literal && !(index.literal instanceof RegExp)) {
                                index = index.literal;
                            }

                            const property: TypeProperty | TypePropertySignature = type.kind === ReflectionKind.propertySignature || type.kind === ReflectionKind.property
                                ? type
                                : { kind: ReflectionKind.propertySignature, name: index, type } as TypePropertySignature;

                            if (property.type.kind !== ReflectionKind.never) {
                                //never is filtered out

                                if (modifier !== 0) {
                                    if (modifier & MappedModifier.optional) {
                                        property.optional = true;
                                    }
                                    if (modifier & MappedModifier.removeOptional && property.optional) {
                                        property.optional = undefined;
                                    }
                                    if (modifier & MappedModifier.readonly) {
                                        property.readonly = true;
                                    }
                                    if (modifier & MappedModifier.removeReadonly && property.readonly) {
                                        property.readonly = undefined;
                                    }
                                }
                                this.push(property);
                            }
                        }
                    } else {
                        this.frame.mappedType = new Loop(this.pop() as Type);
                    }

                    const next = this.frame.mappedType.next();
                    if (next === undefined) {
                        //end
                        this.push({ kind: ReflectionKind.objectLiteral, types: this.popFrame() });
                    } else {
                        this.stack[this.frame.startIndex + 1] = next; //change the mapped type parameter
                        this.call(functionPointer, -2);
                    }
                    break;
                }
                case ReflectionOp.loads: {
                    const frameOffset = this.eatParameter(ops) as number;
                    const stackEntryIndex = this.eatParameter(ops) as number;
                    if (frameOffset === 0) {
                        this.push(this.stack[this.frame.startIndex + 1 + stackEntryIndex]);
                    } else if (frameOffset === 1) {
                        this.push(this.stack[this.frame.previous!.startIndex + 1 + stackEntryIndex]);
                    } else if (frameOffset === 2) {
                        this.push(this.stack[this.frame.previous!.previous!.startIndex + 1 + stackEntryIndex]);
                    } else if (frameOffset === 3) {
                        this.push(this.stack[this.frame.previous!.previous!.previous!.startIndex + 1 + stackEntryIndex]);
                    } else if (frameOffset === 4) {
                        this.push(this.stack[this.frame.previous!.previous!.previous!.previous!.startIndex + 1 + stackEntryIndex]);
                    } else {
                        let current = this.frame;
                        for (let i = 0; i < frameOffset; i++) current = current.previous!;
                        this.push(this.stack[current.startIndex + 1 + stackEntryIndex]);
                    }
                    break;
                }
                case ReflectionOp.arg: {
                    const arg = this.eatParameter(ops) as number;
                    this.push(this.stack[this.frame.startIndex - arg]);
                    break;
                }
                case ReflectionOp.return: {
                    this.returnFrame();
                    break;
                }
                case ReflectionOp.frame: {
                    this.pushFrame();
                    break;
                }
                case ReflectionOp.moveFrame: {
                    const type = this.pop();
                    this.popFrame();
                    if (type) this.push(type);
                    break;
                }
                case ReflectionOp.jump: {
                    const arg = this.eatParameter(ops) as number;
                    this.program = arg - 1; //-1 because next iteration does program++
                    break;
                }
                case ReflectionOp.call: {
                    const program = this.eatParameter(ops) as number;
                    this.call(program);
                    break;
                }
                case ReflectionOp.inline: {
                    const pPosition = this.eatParameter(ops) as number;
                    const pOrFn = initialStack[pPosition] as number | Packed | (() => Packed);
                    const p = isFunction(pOrFn) ? pOrFn() : pOrFn;
                    if ('number' === typeof p) {
                        //self circular reference, usually a 0, which indicates we put the result of the current program as the type on the stack.
                        this.push(this.resultType);
                    } else {
                        const result = resolveRuntimeType(p, [], this.registry);
                        if (isWithAnnotations(result)) {
                            result.typeName = isFunction(pOrFn) ? pOrFn.toString().replace('() => __Ω', '') : '';
                        }
                        this.push(result);
                    }
                    break;
                }
                case ReflectionOp.inlineCall: {
                    const pPosition = this.eatParameter(ops) as number;
                    const argumentSize = this.eatParameter(ops) as number;
                    const inputs: any[] = [];
                    for (let i = 0; i < argumentSize; i++) {
                        let input = this.pop() as Type;
                        if (input.kind === ReflectionKind.never && initialInputs[i]) input = initialInputs[i] as Type;
                        inputs.unshift(input);
                    }
                    const pOrFn = initialStack[pPosition] as number | Packed | (() => Packed);
                    const p = isFunction(pOrFn) ? pOrFn() : pOrFn;
                    if ('number' === typeof p && argumentSize === 0) {
                        //self circular reference, usually a 0, which indicates we put the result of the current program as the type on the stack.
                        this.push(this.resultType);
                    } else {
                        let result: Type = { kind: ReflectionKind.never };
                        if ('number' === typeof p) {
                            const processor = new Processor(this.forType, this.registry);
                            result = processor.run(ops, initialStack, inputs) as Type;
                        } else {
                            const pack = unpack(p);
                            const processor = new Processor(p, this.registry);
                            result = processor.run(pack.ops, pack.stack, inputs) as Type;
                        }

                        if (isWithAnnotations(result)) {
                            result.typeName = isFunction(pOrFn) ? pOrFn.toString().replace('() => __Ω', '') : '';
                            result.typeArguments = inputs;
                        }

                        this.push(result);
                    }
                    break;
                }
            }
        }

        return narrowOriginalLiteral(this.stack[this.stackPointer] as Type);
    }

    push(entry: RuntimeStackEntry): void {
        this.stack[++this.stackPointer] = entry;
    }

    pop(): RuntimeStackEntry {
        if (this.stackPointer < 0) throw new Error('Stack empty');
        return this.stack[this.stackPointer--];
    }

    pushFrame(): void {
        this.frame = {
            index: this.frame.index + 1,
            startIndex: this.stackPointer,
            previous: this.frame,
            variables: 0,
            inputs: [],
        };
    }

    popFrame(): RuntimeStackEntry[] {
        const result = this.stack.slice(this.frame.startIndex + this.frame.variables + 1, this.stackPointer + 1);
        this.stackPointer = this.frame.startIndex;
        if (this.frame.previous) this.frame = this.frame.previous;
        return result;
    }

    /**
     * Create a new stack frame with the calling convention.
     */
    call(program: number, jumpBackTo: number = 1): void {
        this.push(this.program + jumpBackTo); //the `return address`
        this.pushFrame();
        // process.stdout.write(`[${this.frame.index}] call ${program}\n`);
        this.program = program - 1; //-1 because next iteration does program++
    }

    /**
     * Removes the stack frame, and puts the latest entry on the stack.
     */
    returnFrame(): void {
        const returnValue = this.pop(); //latest entry on the stack is the return value
        const returnAddress = this.stack[this.frame.startIndex]; //startIndex points the to new frame - 1 position, which is the `return address`.
        // process.stdout.write(`[${this.frame.index}] return ${returnAddress}\n`);
        this.stackPointer = this.frame.startIndex - 1; //-1 because call convention adds `return address` before entering new frame
        this.push(returnValue);
        if ('number' === typeof returnAddress) this.program = returnAddress - 1; //-1 because iteration does program++
        if (this.frame.previous) this.frame = this.frame.previous;
    }

    pushType(type: Type): void {
        this.push(type);
    }

    eatParameter(ops: ReflectionOp[]): RuntimeStackEntry {
        return ops[++this.program];
    }
}
