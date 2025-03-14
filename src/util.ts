export class ZongoUtil {
    static timeout(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    static updateValueInObject(
        obj: any,
        path: string,
        func: (value: any) => any
    ) {
        let current = obj;

        const keys = path.split(".");
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (!(key in current)) {
                throw new Error(`Key ${key} (Path: ${keys.join(" > ")}) does not exist in object!`);
            }
            if (i === keys.length - 1) {
                current[key] = func(current[key]);
            }
            else {
                current = current[key];
            }
        }
    }
}