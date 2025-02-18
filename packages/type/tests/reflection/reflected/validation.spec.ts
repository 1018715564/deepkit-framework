import { expect, test } from '@jest/globals';
import { Email, MaxLength, MinLength, Positive, Validate, validate, ValidatorError } from '../../../src/validator';
import { is } from '../../../src/typeguard';
import { AutoIncrement, Excluded, Group, integer, PrimaryKey, Type, Unique } from '../../../src/reflection/type';
import { t } from '../../../src/decorator';
import { ReflectionClass, typeOf } from '../../../src/reflection/reflection';

test('email', () => {
    expect(is<Email>('peter@example.com')).toBe(true);
    expect(is<Email>('nope')).toBe(false);
    expect(is<Email>('nope@')).toBe(false);
    expect(is<Email>('@')).toBe(false);

    expect(validate<Email>('peter@example.com')).toEqual([]);
    expect(validate<Email>('nope')).toEqual([{ path: '', code: 'pattern', message: `Pattern ^\\S+@\\S+$ does not match` }]);
    expect(validate<Email>('nope@')).toEqual([{ path: '', code: 'pattern', message: `Pattern ^\\S+@\\S+$ does not match` }]);
    expect(validate<Email>('@')).toEqual([{ path: '', code: 'pattern', message: `Pattern ^\\S+@\\S+$ does not match` }]);
});

test('minLength', () => {
    type Username = string & MinLength<3>;

    expect(is<Username>('abc')).toBe(true);
    expect(is<Username>('ab')).toBe(false);

    expect(validate<Username>('abc')).toEqual([]);
    expect(validate<Username>('ab')).toEqual([{ path: '', code: 'minLength', message: `Min length is 3` }]);
});

test('custom validator pre defined', () => {
    function startsWith(v: string) {
        return (value: any) => {
            const valid = 'string' === typeof value && value.startsWith(v);
            return valid ? undefined : new ValidatorError('startsWith', `Does not start with ${v}`);
        };
    }

    const startsWithA = startsWith('a');
    type MyType = string & Validate<typeof startsWithA>;

    expect(is<MyType>('aah')).toBe(true);
    expect(is<MyType>('nope')).toBe(false);
    expect(validate<MyType>('nope')).toEqual([{ path: '', code: 'startsWith', message: `Does not start with a` }]);
});

test('custom validator with arguments', () => {
    function startsWith(value: any, type: Type, letter: string) {
        const valid = 'string' === typeof value && value.startsWith(letter);
        return valid ? undefined : new ValidatorError('startsWith', `Does not start with ${letter}`);
    }

    type MyType = string & Validate<typeof startsWith, 'a'>;

    expect(is<MyType>('aah')).toBe(true);
    expect(is<MyType>('nope')).toBe(false);
    expect(validate<MyType>('nope')).toEqual([{ path: '', code: 'startsWith', message: `Does not start with a` }]);

    type InvalidValidatorOption = string & Validate<typeof startsWith>;
    expect(() => is<InvalidValidatorOption>('aah')).toThrow(`Invalid option value given to validator function startsWith, expected letter: string`);
});

test('decorator validator', () => {
    function minLength(length: number) {
        return (value: any): ValidatorError | void => {
            if ('string' === typeof value && value.length < length) return new ValidatorError('length', `Min length of ${length}`);
        };
    }

    class User {
        @t.validate(minLength(3))
        username!: string;
    }

    const reflection = ReflectionClass.from(User);
    const userType = typeOf<User>();
    //non-generic classes are cached
    expect(userType === reflection.type).toBe(true);

    expect(validate<User>({ username: 'Peter' })).toEqual([]);
    expect(validate<User>({ username: 'Pe' })).toEqual([{ path: 'username', code: 'length', message: `Min length of 3` }]);
});

test('class', () => {
    class User {
        id: integer & PrimaryKey & AutoIncrement & Positive = 0;

        email?: Email & Group<'sensitive'>;

        firstName?: string & MaxLength<128>;
        lastName?: string & MaxLength<128>;

        logins: integer & Positive & Excluded<'json'> = 0;

        constructor(public username: string & MinLength<3> & MaxLength<24> & Unique) {
        }
    }

    expect(is<User>({ id: 0, logins: 0, username: 'Peter' })).toBe(true);
    expect(is<User>({ id: -1, logins: 0, username: 'Peter' })).toBe(false);
    expect(is<User>({ id: 0, logins: 0, username: 'AB' })).toBe(false);
    expect(is<User>({ id: 0, logins: 0, username: 'Peter', email: 'abc@abc' })).toBe(true);
    expect(is<User>({ id: 0, logins: 0, username: 'Peter', email: 'abc' })).toBe(false);
});

test('path', () => {
    class Config {
        name!: string;
        value!: number;
    }

    class Container1 {
        configs: Config[] = [];
    }

    // expect(validate<Container1>({ configs: [{ name: 'a', value: 3 }] })).toEqual([]);
    expect(validate<Container1>({ configs: {} })).toEqual([{ code: 'type', message: 'Not an array', path: 'configs' }]);
    expect(validate<Container1>({ configs: [{ name: 'a', value: 123 }, { name: '12' }] })).toEqual([{ code: 'type', message: 'Not a number', path: 'configs.1.value' }]);

    class Container2 {
        configs: { [name: string]: Config } = {};
    }

    expect(validate<Container2>({ configs: { a: { name: 'b' } } })).toEqual([{ code: 'type', message: 'Not a number', path: 'configs.a.value' }]);
    expect(validate<Container2>({ configs: { a: { name: 'b', value: 123 }, b: { name: 'b' } } })).toEqual([{ code: 'type', message: 'Not a number', path: 'configs.b.value' }]);
});

test('class with union literal', () => {
    class ConnectionOptions {
        readConcernLevel: 'local' | 'majority' | 'linearizable' | 'available' = 'majority';
    }

    expect(validate<ConnectionOptions>({ readConcernLevel: 'majority' })).toEqual([]);
    expect(validate<ConnectionOptions>({ readConcernLevel: 'invalid' })).toEqual([{code: 'type', message: 'Invalid type', path: 'readConcernLevel'}]);
});

test('named tuple', () => {
    expect(validate<[name: string]>(['asd'])).toEqual([]);
    expect(validate<[name: string]>([23])).toEqual([{code: 'type', message: 'Not a string', path: 'name'}]);
});

test('inherited validations', () => {
    class User {
        username!: string & MinLength<3>;
    }

    class AddUserDto extends User {
        image?: string;
    }

    expect(validate<User>({ username: 'Pe' })).toEqual([{code: 'minLength', message: 'Min length is 3', path: 'username'}]);
    expect(validate<User>({ username: 'Peter' })).toEqual([]);

    expect(validate<AddUserDto>({ username: 'Pe' })).toEqual([{code: 'minLength', message: 'Min length is 3', path: 'username'}]);
    expect(validate<AddUserDto>({ username: 'Peter' })).toEqual([]);
});
