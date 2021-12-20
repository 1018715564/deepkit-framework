import { expect, test } from '@jest/globals';
import { Serializer, TypeGuardRegistry } from '../src/serializer';
import { ReflectionKind } from '../src/reflection/type';

test('TypeGuardRegistry', () => {
    const serializer = new Serializer();
    serializer.clear();

    function number1() {
    }

    function number2() {
    }

    serializer.typeGuards.register(2, ReflectionKind.number, number2);
    serializer.typeGuards.register(1, ReflectionKind.number, number1);

    const registries = serializer.typeGuards.getSortedTemplateRegistries();

    expect(registries[0][1].get({kind: ReflectionKind.number})[0]).toBe(number1);
    expect(registries[1][1].get({kind: ReflectionKind.number})[0]).toBe(number2);
});
