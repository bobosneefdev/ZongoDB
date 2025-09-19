export type Paths<T> = T extends object
	? {
			[K in keyof T]: K extends string | number
				? T[K] extends object
					? T[K] extends any[]
						?
								| `${K}`
								| `${K}${"."}${number}`
								| `${K}${"."}${Paths<T[K][number]>}`
						: `${K}` | `${K}${"."}${Paths<T[K]>}`
					: `${K}`
				: never;
		}[keyof T]
	: never;