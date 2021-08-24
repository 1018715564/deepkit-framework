/*
 * Deepkit Framework
 * Copyright (C) 2021 Deepkit UG, Marc J. Schmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * You should have received a copy of the MIT License along with this program.
 */

import { ClassSchema, ExtractClassDefinition, FieldDecoratorWrapper, getClassSchema, jsonSerializer, PlainSchemaProps, PropertySchema, t } from '@deepkit/type';
import { isClassProvider, isExistingProvider, isFactoryProvider, isValueProvider, Provider, ProviderWithScope, Tag, TagProvider, TagRegistry } from './provider';
import { ClassType, CompilerContext, CustomError, getClassName, getClassTypeFromInstance, isClass, isFunction, isPrototypeOfBase } from '@deepkit/core';
import { InjectorModule } from './module';
import { InjectorContext } from './injector-context';


export class ConfigToken<T extends {}> {
    constructor(public config: ConfigDefinition<T>, public name: keyof T & string) {
    }
}

export class ConfigSlice<T extends {}> {
    public bag?: { [name: string]: any };
    public config!: ConfigDefinition<T>;

    // public names!: (keyof T & string)[];

    constructor(config: ConfigDefinition<T>, names: (keyof T & string)[]) {
        //we want that ConfigSlice acts as a regular plain object, which can be serialized at wish.
        let bag: { [name: string]: any } = {};

        Object.defineProperties(this, {
            config: { enumerable: false, get: () => config },
            bag: { enumerable: false, set: (v) => bag = v },
        });

        for (const name of names) {
            Object.defineProperty(this, name, {
                enumerable: true,
                get: () => bag[name]
            });
        }
    }

    valueOf() {
        return { ...this };
    }
}

export class ConfigDefinition<T extends {}> {
    protected moduleClass?: ClassType<InjectorModule>;

    public type!: T;

    constructor(
        public readonly schema: ClassSchema<T>
    ) {
    }

    setModuleClass(module: InjectorModule) {
        this.moduleClass = getClassTypeFromInstance(module);
    }

    hasModuleClass(): boolean {
        return this.moduleClass !== undefined;
    }

    getModuleClass(): ClassType<InjectorModule> {
        if (!this.moduleClass) throw new Error('Configuration is not assigned to a module. Make sure your config is assigned to a single module. See createModule({config: x}).');

        return this.moduleClass;
    }

    getDefaults(): any {
        return jsonSerializer.for(this.schema).validatedDeserialize({});
    }

    all(): ClassType<T> {
        const self = this;
        return class extends ConfigSlice<T> {
            constructor() {
                super(self, [...self.schema.getProperties()].map(v => v.name) as any);
            }
        } as any;
    }

    slice<N extends (keyof T & string)[]>(...names: N): ClassType<Pick<T, N[number]>> {
        const self = this;
        return class extends ConfigSlice<T> {
            constructor() {
                super(self, names);
            }
        } as any;
    }

    token<N extends (keyof T & string)>(name: N): ConfigToken<T> {
        return new ConfigToken(this, name);
    }
}

export class InjectorReference {
    constructor(public readonly to: any) {
    }
}

export function injectorReference<T>(classTypeOrToken: T): any {
    return new InjectorReference(classTypeOrToken);
}

export function createConfig<T extends PlainSchemaProps>(config: T): ConfigDefinition<ExtractClassDefinition<T>> {
    return new ConfigDefinition(t.schema(config));
}

export interface InjectDecorator {
    (target: object, property?: string, parameterIndexOrDescriptor?: any): any;

    /**
     * Mark as optional.
     */
    readonly optional: this;

    /**
     * Resolves the dependency token from the root injector.
     */
    readonly root: this;

    readonly options: { token: any, optional: boolean, root: boolean };
}

export type InjectOptions = {
    token: any | ForwardRef<any>;
    optional: boolean;
    root: boolean;
};

type ForwardRef<T> = () => T;

const injectSymbol = Symbol('inject');

export function isInjectDecorator(v: any): v is InjectDecorator {
    return isFunction(v) && v.hasOwnProperty(injectSymbol);
}

export function inject(token?: any | ForwardRef<any>): InjectDecorator {
    const injectOptions: InjectOptions = {
        optional: false,
        root: false,
        token: token,
    };

    const fn = (target: object, propertyOrMethodName?: string, parameterIndexOrDescriptor?: any) => {
        FieldDecoratorWrapper((target: object, property, returnType) => {
            property.data['deepkit/inject'] = injectOptions;
            property.setFromJSType(returnType);
        })(target, propertyOrMethodName, parameterIndexOrDescriptor);
    };

    Object.defineProperty(fn, injectSymbol, { value: true, enumerable: false });

    Object.defineProperty(fn, 'optional', {
        get() {
            injectOptions.optional = true;
            return fn;
        }
    });

    Object.defineProperty(fn, 'options', {
        get() {
            return injectOptions;
        }
    });

    Object.defineProperty(fn, 'root', {
        get() {
            injectOptions.optional = true;
            return fn;
        }
    });

    return fn as InjectDecorator;
}

export class InjectToken {
    constructor(public readonly name: string) {
    }

    toString() {
        return 'InjectToken=' + this.name;
    }
}

/**
 * This decorator makes sure that meta-data is emitted by TypeScript from your constructor.
 *
 * This works in combination with the tsconfig setting "emitDecoratorMetadata".
 *
 * To have runtime type information available of constructor arguments, you have to use this
 * decorator. While technically its not required for anything else (even if you have no
 * constructor arguments at all), it is recommended to just add it to all services. This makes
 * sure you don't get surprising behaviour when you add constructor arguments at a later time.
 *
 * ```typescript
 * @injectable()
 * class Service {}
 *
 * @injectable()
 * class Service {
 *     constructor(private other: OtherService) {}
 * }
 * ```
 */
export function injectable() {
    return (target: object) => {
        //don't do anything. This is just used to generate type metadata.
    };
}

export class CircularDependencyError extends CustomError {
}

export class TokenNotFoundError extends CustomError {
}

export class DependenciesUnmetError extends CustomError {
}

export function tokenLabel(token: any): string {
    if (token === null) return 'null';
    if (token === undefined) return 'undefined';
    if (token instanceof TagProvider) return 'Tag(' + getClassName(token.provider.provide) + ')';
    if (isClass(token)) return getClassName(token);
    if (isFunction(token.toString)) return token.toString();

    return token + '';
}

export interface ConfigContainer {
    get(path: string): any;
}

let CircularDetector: any[] = [];
let CircularDetectorResets: (() => void)[] = [];

export interface BasicInjector {
    get<T, R = T extends ClassType<infer R> ? R : T>(token: T, frontInjector?: BasicInjector): R;

    getInjectorForModule(module: InjectorModule): BasicInjector;
}

export class Injector implements BasicInjector {
    public circularCheck: boolean = true;

    protected resolved: any[] = [];

    protected retriever(injector: Injector, token: any, frontInjector?: Injector): any {
        for (const parent of injector.parents) {
            const v = 'retriever' in parent ? parent.retriever(parent, token, frontInjector) : parent.get(token, frontInjector);
            if (v !== undefined) return v;
        }
        return undefined;
    }

    constructor(
        protected providers: Provider[] = [],
        protected parents: (BasicInjector | Injector)[] = [],
        protected injectorContext: InjectorContext = new InjectorContext,
        protected configuredProviderRegistry: ConfiguredProviderRegistry | undefined = undefined,
        protected tagRegistry: TagRegistry = new TagRegistry(),
        protected contextResolver?: { getInjectorForModule(module: InjectorModule): BasicInjector },
        protected context?: Context
    ) {
        if (!this.configuredProviderRegistry) this.configuredProviderRegistry = injectorContext.configuredProviderRegistry;
        if (this.providers.length) this.retriever = this.buildRetriever();
    }

    getInjectorForModule(module: InjectorModule): BasicInjector {
        return this.contextResolver ? this.contextResolver.getInjectorForModule(module) : this;
    }

    /**
     * Creates a clone of this instance, maintains the provider structure, but drops provider instances.
     * Note: addProviders() in the new fork changes the origin, since providers array is not cloned.
     */
    public fork(parents?: Injector[], injectorContext?: InjectorContext) {
        const injector = new Injector(undefined, parents || this.parents, injectorContext, this.configuredProviderRegistry, this.tagRegistry, this.contextResolver);
        injector.providers = this.providers;
        injector.retriever = this.retriever;
        injector.context = this.context;
        return injector;
    }

    /**
     * Changes the provider structure of this injector.
     *
     * Note: This is very performance sensitive. Every time you call this function a new dependency injector function
     * is generated, which si pretty slow. So, it's recommended to create a Injector with providers in the constructor
     * and not change it.
     */
    public addProviders(...providers: Provider[]) {
        this.providers.push(...providers);
        this.retriever = this.buildRetriever();
    }

    public isRoot() {
        return this.parents.length === 0;
    }

    protected resolveModuleFromContextTree(moduleClass: ClassType<InjectorModule>): InjectorModule {
        if (!this.context) {
            throw new Error('Injector has no context assigned. Module configuration resolving can not be done.');
        }

        if (this.context.module instanceof moduleClass) return this.context.module;

        for (const exported of this.context.exportedContexts) {
            if (exported.module instanceof moduleClass) return exported.module;
        }

        throw new Error(
            `Injector has no context assigned for ${getClassName(moduleClass)}. Context is for ${getClassName(this.context.module)}#${this.context.id}. ` +
            `${this.context.exportedContexts.length} modules [${this.context.exportedContexts.map(v => getClassName(v.module) + '#' + v.id).join(', ')}] exported to this module. ` +
            `Module configuration resolving can not be done.`
        );
    }

    protected createFactoryProperty(options: { name: string | number, token: any, optional: boolean }, compiler: CompilerContext, ofName: string, argPosition: number, notFoundFunction: string) {
        const token = options.token;

        if (token instanceof ConfigDefinition) {
            if (token.hasModuleClass()) {
                const module = this.resolveModuleFromContextTree(token.getModuleClass());
                return compiler.reserveVariable('fullConfig', module.getConfig());
            } else {
                return compiler.reserveVariable('fullConfig', token.getDefaults());
            }
        } else if (token instanceof ConfigToken) {
            try {
                if (token.config.hasModuleClass()) {
                    const module = this.resolveModuleFromContextTree(token.config.getModuleClass());
                    const config = module.getConfig();
                    return compiler.reserveVariable(token.name, (config as any)[token.name]);
                } else {
                    const config = token.config.getDefaults();
                    return compiler.reserveVariable(token.name, (config as any)[token.name]);
                }
            } catch (error) {
                throw new Error(`Could not resolve configuration token '${token.name}': ${error.message}`);
            }
        } else if (isClass(token) && (Object.getPrototypeOf(Object.getPrototypeOf(token)) === ConfigSlice || Object.getPrototypeOf(token) === ConfigSlice)) {
            const value: ConfigSlice<any> = new token;
            try {
                if (value.config.hasModuleClass()) {
                    const module = this.resolveModuleFromContextTree(value.config.getModuleClass());
                    value.bag = module.getConfig();
                } else {
                    value.bag = value.config.getDefaults();
                }
            } catch (error) {
                throw new Error(`Could not resolve configuration slice ${getClassName(token)}: ${error.message}`);
            }
            return compiler.reserveVariable('configSlice', value);
        } else if (token === TagRegistry) {
            return compiler.reserveVariable('tagRegistry', this.tagRegistry);
        } else if (isPrototypeOfBase(token, Tag)) {
            const tokenVar = compiler.reserveVariable('token', token);
            const providers = compiler.reserveVariable('tagRegistry', this.tagRegistry.resolve(token));
            return `new ${tokenVar}(${providers}.map(v => (frontInjector.retriever ? frontInjector.retriever(frontInjector, v, frontInjector) : frontInjector.get(v, frontInjector))))`;
        } else {
            if (token === undefined) {
                let of = `${ofName}.${options.name}`;
                if (argPosition >= 0) {
                    const argsCheck: string[] = [];
                    for (let i = 0; i < argPosition; i++) argsCheck.push('✓');
                    argsCheck.push('?');
                    of = `${ofName}(${argsCheck.join(', ')})`;
                }

                throw new DependenciesUnmetError(
                    `Undefined dependency '${options.name}: undefined' of ${of}. Dependency '${options.name}' has no type. Imported reflect-metadata correctly? ` +
                    `Use '@inject(PROVIDER) ${options.name}: T' if T is an interface. For circular references use @inject(() => T) ${options.name}: T.`
                );
            }
            const tokenVar = compiler.reserveVariable('token', token);
            const orThrow = options.optional ? '' : `?? ${notFoundFunction}(${JSON.stringify(ofName)}, ${JSON.stringify(options.name)}, ${argPosition}, ${tokenVar})`;

            return `(frontInjector.retriever ? frontInjector.retriever(frontInjector, ${tokenVar}, frontInjector) : frontInjector.get(${tokenVar}, frontInjector)) ${orThrow}`;
        }

        return 'undefined';
    }

    protected optionsFromProperty(property: PropertySchema): { token: any, name: string | number, optional: boolean } {
        const options = property.data['deepkit/inject'] as InjectOptions | undefined;
        let token: any = property.resolveClassType;

        if (options && options.token) {
            token = isFunction(options.token) ? options.token() : options.token;
        }

        return { token, name: property.name, optional: !!options && options.optional };
    }

    protected createFactory(compiler: CompilerContext, classType: ClassType): string {
        if (!classType) throw new Error('Can not create factory for undefined ClassType');
        const schema = getClassSchema(classType);
        const args: string[] = [];
        const propertyAssignment: string[] = [];
        const classTypeVar = compiler.reserveVariable('classType', classType);

        for (const property of schema.getMethodProperties('constructor')) {
            if (!property) {
                console.log('Constructor arguments', schema.getMethodProperties('constructor'));
                throw new Error(`Constructor arguments hole in ${getClassName(classType)}`);
            }
            // try {
                args.push(this.createFactoryProperty(this.optionsFromProperty(property), compiler, getClassName(classType), args.length, 'constructorParameterNotFound'));
            // } catch (error) {
            //     throw new Error(`Could not resolve constructor injection token ${getClassName(classType)}.${property.name}: ${error.message}`);
            // }
        }

        for (const property of schema.getProperties()) {
            if (!('deepkit/inject' in property.data)) continue;
            if (property.methodName === 'constructor') continue;
            try {
                propertyAssignment.push(`v.${property.name} = ${this.createFactoryProperty(this.optionsFromProperty(property), compiler, getClassName(classType), -1, 'propertyParameterNotFound')};`);
            } catch (error) {
                throw new Error(`Could not resolve property injection token ${getClassName(classType)}.${property.name}: ${error.message}`);
            }
        }

        return `v = new ${classTypeVar}(${args.join(',')});\n${propertyAssignment.join('\n')}`;
    }

    protected buildRetriever(): (injector: Injector, token: any, frontInjector?: Injector) => any {
        const compiler = new CompilerContext();
        const lines: string[] = [];
        const resets: string[] = [];
        this.resolved = [];

        lines.push(`
            case ${compiler.reserveVariable('injectorContextClassType', InjectorContext)}: return injector.injectorContext;
            case ${compiler.reserveVariable('injectorClassType', Injector)}: return injector;
        `);

        let resolvedIds = 0;
        const normalizedProviders = new Map<any, Provider>();

        //make sure that providers that declare the same provider token will be filtered out so that the last will be used.
        for (const provider of this.providers) {
            if (provider instanceof TagProvider) {
                normalizedProviders.set(provider, provider);
            } else if (isValueProvider(provider)) {
                normalizedProviders.set(provider.provide, provider);
            } else if (isClassProvider(provider)) {
                normalizedProviders.set(provider.provide, provider);
            } else if (isExistingProvider(provider)) {
                normalizedProviders.set(provider.provide, provider);
            } else if (isFactoryProvider(provider)) {
                normalizedProviders.set(provider.provide, provider);
            } else if (isClass(provider)) {
                normalizedProviders.set(provider, provider);
            }
        }

        for (let provider of normalizedProviders.values()) {
            const resolvedId = resolvedIds++;
            this.resolved.push(undefined);
            let transient = false;
            let factory = '';
            let token: any;
            const tagToken = provider instanceof TagProvider ? provider : undefined;
            if (provider instanceof TagProvider) {
                provider = provider.provider;
            }

            if (isValueProvider(provider)) {
                transient = provider.transient === true;
                token = provider.provide;
                const valueVar = compiler.reserveVariable('useValue', provider.useValue);
                factory = `v = ${valueVar};`;
            } else if (isClassProvider(provider)) {
                transient = provider.transient === true;
                token = provider.provide;
                factory = this.createFactory(compiler, provider.useClass || provider.provide);
            } else if (isExistingProvider(provider)) {
                transient = provider.transient === true;
                token = provider.provide;
                factory = this.createFactory(compiler, provider.useExisting);
            } else if (isFactoryProvider(provider)) {
                transient = provider.transient === true;
                token = provider.provide;

                const args: string[] = [];
                let i = 0;
                for (const dep of provider.deps || []) {
                    let optional = false;
                    let token = dep;

                    if (isInjectDecorator(dep)) {
                        optional = dep.options.optional;
                        token = dep.options.token;
                    }

                    if (!token) {
                        throw new Error(`No token defined for dependency ${i} in 'deps' of useFactory for ${tokenLabel(provider.provide)}`);
                    }

                    args.push(this.createFactoryProperty({
                        name: i++,
                        token,
                        optional,
                    }, compiler, 'useFactory', args.length, 'factoryDependencyNotFound'));
                }

                factory = `v = ${compiler.reserveVariable('factory', provider.useFactory)}(${args.join(', ')});`;
            } else if (isClass(provider)) {
                token = provider;
                factory = this.createFactory(compiler, provider);
            } else {
                throw new Error('Invalid provider');
            }

            if (tagToken) token = tagToken;

            const tokenVar = compiler.reserveVariable('token', token);
            const creatingVar = compiler.reserveVariable('creating', false);
            const configuredProviderCalls = this.configuredProviderRegistry?.get(token);

            const configureProvider: string[] = [];
            if (configuredProviderCalls) {
                configuredProviderCalls.sort((a, b) => {
                    return a.order - b.order;
                });

                for (const call of configuredProviderCalls) {
                    if (call.type === 'stop') break;
                    if (call.type === 'call') {
                        const args: string[] = [];
                        const methodName = 'symbol' === typeof call.methodName ? '[' + compiler.reserveVariable('arg', call.methodName) + ']' : call.methodName;
                        for (const arg of call.args) {
                            if (arg instanceof InjectorReference) {
                                args.push(`frontInjector.get(${compiler.reserveVariable('forward', arg.to)})`);
                            } else {
                                args.push(`${compiler.reserveVariable('arg', arg)}`);
                            }
                        }

                        configureProvider.push(`v.${methodName}(${args.join(', ')});`);
                    }
                    if (call.type === 'property') {
                        const property = 'symbol' === typeof call.property ? '[' + compiler.reserveVariable('property', call.property) + ']' : call.property;
                        const value = call.value instanceof InjectorReference ? `frontInjector.get(${compiler.reserveVariable('forward', call.value.to)})` : compiler.reserveVariable('value', call.value);
                        configureProvider.push(`v.${property} = ${value};`);
                    }
                }
            } else {
                configureProvider.push('//no custom provider setup');
            }

            resets.push(`${creatingVar} = false;`);

            lines.push(`
                //${tokenLabel(token)}
                case ${tokenVar}: {
                    ${transient ? 'let v;' : `let v = injector.resolved[${resolvedId}]; if (v !== undefined) return v;`}
                    CircularDetector.push(${tokenVar});
                    if (${creatingVar}) {
                        throwCircularDependency();
                    }
                    ${creatingVar} = true;
                    ${factory}
                    ${transient ? '' : `injector.resolved[${resolvedId}] = v;`}
                    ${creatingVar} = false;
                    ${configureProvider.join('\n')}
                    CircularDetector.pop();
                    return v;
                }
            `);
        }

        const parents: string[] = [];
        for (let i = 0; i < this.parents.length; i++) {
            let retriever = 'retriever' in this.parents[i] ? `injector.parents[${i}].retriever(injector.parents[${i}], ` : `injector.parents[${i}].get(`;
            parents.push(`
                {
                    const v = ${retriever}token, frontInjector);
                    if (v !== undefined) return v;
                }
            `);
        }

        compiler.context.set('CircularDetector', CircularDetector);
        compiler.context.set('throwCircularDependency', throwCircularDependency);
        compiler.context.set('CircularDetectorResets', CircularDetectorResets);
        compiler.context.set('constructorParameterNotFound', constructorParameterNotFound);
        compiler.context.set('factoryDependencyNotFound', factoryDependencyNotFound);
        compiler.context.set('propertyParameterNotFound', propertyParameterNotFound);

        compiler.preCode = `
            CircularDetectorResets.push(() => {
                ${resets.join('\n')};
            });
        `;

        return compiler.build(`
        frontInjector = frontInjector || injector;

        switch (token) {
            ${lines.join('\n')}
        }

        ${parents.join('\n')}

        return undefined;
        `, 'injector', 'token', 'frontInjector') as any;
    }

    public get<T, R = T extends ClassType<infer R> ? R : T>(token: T, frontInjector?: Injector): R {
        const v = this.retriever(this, token, frontInjector || this);
        if (v !== undefined) return v;

        for (const reset of CircularDetectorResets) reset();
        throw new TokenNotFoundError(`Could not resolve injector token ${tokenLabel(token)}`);
    }
}

function constructorParameterNotFound(ofName: string, name: string, position: number, token: any) {
    const argsCheck: string[] = [];
    for (let i = 0; i < position; i++) argsCheck.push('✓');
    argsCheck.push('?');

    for (const reset of CircularDetectorResets) reset();
    throw new DependenciesUnmetError(
        `Unknown constructor argument '${name}: ${tokenLabel(token)}' of ${ofName}(${argsCheck.join(', ')}). Make sure '${tokenLabel(token)}' is provided.`
    );
}

function factoryDependencyNotFound(ofName: string, name: string, position: number, token: any) {
    const argsCheck: string[] = [];
    for (let i = 0; i < position; i++) argsCheck.push('✓');
    argsCheck.push('?');

    for (const reset of CircularDetectorResets) reset();
    throw new DependenciesUnmetError(
        `Unknown factory dependency argument '${tokenLabel(token)}' of ${ofName}(${argsCheck.join(', ')}). Make sure '${tokenLabel(token)}' is provided.`
    );
}

function propertyParameterNotFound(ofName: string, name: string, position: number, token: any) {
    for (const reset of CircularDetectorResets) reset();
    throw new DependenciesUnmetError(
        `Unknown property parameter ${name} of ${ofName}. Make sure '${tokenLabel(token)}' is provided.`
    );
}

function throwCircularDependency() {
    const path = CircularDetector.map(tokenLabel).join(' -> ');
    CircularDetector.length = 0;
    for (const reset of CircularDetectorResets) reset();
    throw new CircularDependencyError(`Circular dependency found ${path}`);
}

export class MemoryInjector extends Injector {
    constructor(protected providers: ({ provide: any, useValue: any } | { provide: any, useFactory: () => any })[]) {
        super();
    }

    fork(parents?: Injector[]): Injector {
        return this;
    }

    protected retriever(injector: Injector, token: any) {
        for (const p of this.providers) {
            if (p.provide === token) return 'useFactory' in p ? p.useFactory() : p.useValue;
        }
    }

    public get<T, R = T extends ClassType<infer R> ? R : T>(token: T, frontInjector?: Injector): R {
        const result = this.retriever(this, token);
        if (result === undefined) throw new TokenNotFoundError(`Could not resolve injector token ${tokenLabel(token)}`);
        return result;
    }
}

export class ContextRegistry {
    public contexts: Context[] = [];

    /**
     * Array with holes as lookup table.
     *
     * Key is AppModule.id (which is unique to each module instance), value is contextId.
     *
     * internal note: We can improve performance by not keeping holes.
     */
    contextLookup: number[] = [];

    get size(): number {
        return this.contexts.length;
    }

    get(id: number): Context {
        return this.contexts[id];
    }

    create(module: InjectorModule): Context {
        const context = new Context(module, this.contexts.length);
        this.add(context);
        return context;
    }

    add(value: Context) {
        this.contexts[value.id] = value;
    }
}

export class ScopedContextScopeCaches {
    protected caches: { [name: string]: ScopedContextCache } = {};

    constructor(protected size: number) {
    }

    getCache(scope: string): ScopedContextCache {
        let cache = this.caches[scope];

        if (!cache) {
            cache = new ScopedContextCache(this.size);
            this.caches[scope] = cache;
        }

        return cache;
    }
}

export class ScopedContextCache {
    protected injectors: (Injector | undefined)[] = new Array(this.size);

    constructor(protected size: number) {
    }

    get(contextId: number): Injector | undefined {
        return this.injectors[contextId];
    }

    set(contextId: number, injector: Injector) {
        this.injectors[contextId] = injector;
    }
}

export class Context {
    providers: ProviderWithScope[] = [];

    /**
     * When a child context exports their providers to this context,
     * then its context is stored in this array. This is necessary to
     * be able to resolve the context later on.
     */
    exportedContexts: Context[] = [];

    constructor(
        public readonly module: InjectorModule,
        public readonly id: number,
        public readonly parent?: Context,
    ) {
    }
}

export type ConfiguredProviderCalls = {
        type: 'call', methodName: string | symbol | number, args: any[], order: number
    }
    | { type: 'property', property: string | symbol | number, value: any, order: number }
    | { type: 'stop', order: number }
    ;

export class ConfiguredProviderRegistry {
    public calls = new Map<any, ConfiguredProviderCalls[]>();

    public add(token: any, ...newCalls: ConfiguredProviderCalls[]) {
        this.get(token).push(...newCalls);
    }

    public get(token: any): ConfiguredProviderCalls[] {
        let calls = this.calls.get(token);
        if (!calls) {
            calls = [];
            this.calls.set(token, calls);
        }
        return calls;
    }

    clone(): ConfiguredProviderRegistry {
        const c = new ConfiguredProviderRegistry;
        for (const [token, calls] of this.calls.entries()) {
            c.calls.set(token, calls.slice());
        }
        return c;
    }
}

export type ConfigureProvider<T> = { [name in keyof T]: T[name] extends (...args: infer A) => any ? (...args: A) => ConfigureProvider<T> : T[name] };
