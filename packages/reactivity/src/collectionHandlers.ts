import { toRaw, reactive, readonly, ReactiveFlags } from './reactive' //引入 reactive 文件中的一些方法和类型变量
import { track, trigger, ITERATE_KEY, MAP_KEY_ITERATE_KEY } from './effect' //引入effect 文件中的一些方法和变量标识
import { TrackOpTypes, TriggerOpTypes } from './operations' //操作数据的行为枚举常量
//一些工具函数
import {
  isObject,
  capitalize,
  hasOwn,
  hasChanged,
  toRawType,
  isMap
} from '@vue/shared'

//类型定义
export type CollectionTypes = IterableCollections | WeakCollections

type IterableCollections = Map<any, any> | Set<any>
type WeakCollections = WeakMap<any, any> | WeakSet<any>
type MapTypes = Map<any, any> | WeakMap<any, any>
type SetTypes = Set<any> | WeakSet<any>
//不同模式下的转换为响应式的方法
//普通模式（可读可写模式下）
const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value
//只读模式下
const toReadonly = <T extends unknown>(value: T): T =>
  isObject(value) ? readonly(value as Record<any, any>) : value
//浅层模式下
const toShallow = <T extends unknown>(value: T): T => value

//获取集合的原型对象
const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

//插装方法 get,访问集合 internal slots(内置插槽) 中存放的属性
//Map,WeakMap
function get(
  target: MapTypes, //这里需要注意 target 目标对象不是 原始集合对象，而是 它的代理对象
  key: unknown,
  isReadonly = false,
  isShallow = false
) {
  // #1772: readonly(reactive(Map)) should return readonly + reactive version
  // of the value
  //获取代理对象的原始集合对象（这里有可能还是个 reactive 响应式，原因看上面英文备注：readonly(reactive(Map))）
  target = (target as any)[ReactiveFlags.RAW]
  //再转一次，如果 target 不是响应式就原路返回，如果是则拿到他的原始集合对象，这一步会始终可以保证拿到原始集合
  const rawTarget = toRaw(target)
  //集合类型 key 可以是对象类型，因此有可能是响应式的，所以要转一下，保证拿到的是原始类型
  const rawKey = toRaw(key)
  //如果 key 不相等，说明，此时key是响应式的
  if (key !== rawKey) {
    //非只读模式下，进行依赖收集，注意这个时候是收集 key 为响应式对象的依赖
    !isReadonly && track(rawTarget, TrackOpTypes.GET, key)
  }
  //这一步依赖是必须收集的，无论key是否是响应式的，永远收集的是 原始值key对应的依赖
  !isReadonly && track(rawTarget, TrackOpTypes.GET, rawKey)
  //从原型上获取 has方法
  const { has } = getProto(rawTarget)
  //获取不同模式下转换方法。toReadonly(深度追踪对象类型属性，深度只读转换),toReactive(深度追踪对象类型属性，深度响应式转换)，toShallow(浅层转换，会直接返回属性值，不做深度追踪)
  const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
  //执行转换，wrap为根据不同模式，获取到的转换方法
  if (has.call(rawTarget, key)) {
    return wrap(target.get(key))
  } else if (has.call(rawTarget, rawKey)) {
    return wrap(target.get(rawKey))
  }
}
//插装方法 has,查询key是否存在于集合中，
//all Collection
//tip: 会发现参数列表第一个参数为this,但是又会发现调用的地方并没有传this，怎么回事呢，这是ts的语法特性，
//在 ts 里是假的参数，放在第一位，用来指定函数中this的类型,调用的地方是不需要传这个参数的，后面方法也是相同情况。
function has(this: CollectionTypes, key: unknown, isReadonly = false): boolean {
  const target = (this as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  const rawKey = toRaw(key)
  //属于查询方法，因此会执行依赖收集，触发 track 方法。
  if (key !== rawKey) {
    !isReadonly && track(rawTarget, TrackOpTypes.HAS, key)
  }
  !isReadonly && track(rawTarget, TrackOpTypes.HAS, rawKey)
  return key === rawKey
    ? target.has(key)
    : target.has(key) || target.has(rawKey)
}
//插装方法 size,获取集合长度
//all Collection
function size(target: IterableCollections, isReadonly = false) {
  //获取到原始集合对象
  target = (target as any)[ReactiveFlags.RAW]
  //非只读模式下去收集依赖(这里是依赖收集track而不是trigger，因为size是一个获取属性)
  !isReadonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
  //这里 size 因为是属性，不是方法，所以通过Reflect.get获取
  return Reflect.get(target, 'size', target)
}
//插装方法 add,往集合 internal slots(内置插槽) 中存属性值
//set ,MapSet
function add(this: SetTypes, value: unknown) {
  //add是操作 set集合 的存值方法，value直接就是要存的属性值。
  //获取原始数据
  value = toRaw(value)
  //获取原始集合对象（这里的this是原始目标集合的proxy代理对象）
  const target = toRaw(this)
  //获取原型
  const proto = getProto(target)
  //调用原型上的 has 方法判断 value是否已经存在，返回布尔值
  const hadKey = proto.has.call(target, value)
  //添加属性
  const result = target.add(value)
  //如果不存在，说明是新值，则去触发依赖更新，否则不去触发，因为重新赋的是已经存在的属性值的。
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, value, value)
  }
  //返回添加属性值后的 Set 结构本身
  return result
}

//插装方法 set,往Map集合 internal slots(内置插槽) 中设置属性/修改 [key,value]
//Map ,WeakMap
function set(this: MapTypes, key: unknown, value: unknown) {
  //获取原始数据
  value = toRaw(value)
  //获取原始集合对象（这里的this是原始目标集合的proxy代理对象）
  const target = toRaw(this)
  //获取 has,get原型方法
  const { has, get } = getProto(target)
  //判断key是否已经存在
  let hadKey = has.call(target, key)
  //不存在，对 key 进行 toRaw转换后再判断（key，可以是对象，因此有可能是一个proxy代理对象）
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }
  //获取旧属性值，以及存入新属性值
  const oldValue = get.call(target, key)
  const result = target.set(key, value)
  //触发依赖更新
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, key, value)
  } else if (hasChanged(value, oldValue)) {
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  return result
}
//插装方法 delete,删除Map/set集合 internal slots(内置插槽) 中的属性
//Map ,WeakMap，Set,WeakSet
function deleteEntry(this: CollectionTypes, key: unknown) {
  const target = toRaw(this)
  const { has, get } = getProto(target)
  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }
  //这里对 get 进行存在性判断原因是，对于set集合，get方法是不存在的。
  const oldValue = get ? get.call(target, key) : undefined
  // forward the operation before queueing reactions
  //在去更新依赖之前先执行删除操作
  const result = target.delete(key)
  //去触发依赖更新，类型为 delete，会更新依赖的值为 undefined
  if (hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}
//插装方法 clear,清空Map/set集合 internal slots(内置插槽)
//Map,Set(WeakSet,WeakMap没有此方法)
function clear(this: IterableCollections) {
  const target = toRaw(this)
  const hadItems = target.size !== 0
  const oldTarget = __DEV__
    ? isMap(target)
      ? new Map(target)
      : new Set(target)
    : undefined
  // forward the operation before queueing reactions
  const result = target.clear()
  if (hadItems) {
    trigger(target, TriggerOpTypes.CLEAR, undefined, undefined, oldTarget)
  }
  return result
}
//插装迭代方法forEach
//Set Map
function createForEach(isReadonly: boolean, isShallow: boolean) {
  return function forEach(
    this: IterableCollections,
    callback: Function,
    thisArg?: unknown //可以显式指定this，默认为集合对象本身。
  ) {
    const observed = this as any //迭代对象，一般为集合的代理对象
    const target = observed[ReactiveFlags.RAW] //获取到代理对象对应的原始集合对象，因为有可能是个reative，下面会再toRaw一下
    const rawTarget = toRaw(target) //真正的原始集合对象
    //不同模式下的转化方法
    const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
    //非只读模式下依赖收集（遍历就是查询操作）
    !isReadonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)
    //执行遍历
    return target.forEach((value: unknown, key: unknown) => {
      // important: make sure the callback is
      // 1. invoked with the reactive map as `this` and 3rd arg
      // 2. the value received should be a corresponding reactive/readonly.
      //执行 callback 回调
      //thisArg是传入的callback方法的调用者，可以显式指定，默认为传入的集合代理对象
      //这里会使用 wrap 函数会对key,value 进行响应式转换，原因是 forEach方法只能被原始集合调用，不能被代理调用，
      //那遍历得到的 value,key是原始值，失去了响应性，因此需要再次处理来恢复响应性。
      return callback.call(thisArg, wrap(value), wrap(key), observed)
    })
  }
}

interface Iterable {
  [Symbol.iterator](): Iterator
}

interface Iterator {
  next(value?: any): IterationResult
}

interface IterationResult {
  value: any
  done: boolean
}

//创建迭代方法
function createIterableMethod(
  method: string | symbol, //方法名
  isReadonly: boolean,
  isShallow: boolean
) {
  return function(
    this: IterableCollections, //在 ts 里是假的参数，放在第一位，用来指定函数中this的类型,调用的地方是不需要传这个参数的
    ...args: unknown[]
  ): Iterable & Iterator {
    const target = (this as any)[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    const targetIsMap = isMap(rawTarget)
    // 如果是entries方法，或者是map的迭代方法的话，isPair为true
    // 这种情况下，迭代器方法返回的是一个[key, value]的结构
    const isPair =
      method === 'entries' || (method === Symbol.iterator && targetIsMap)
    const isKeyOnly = method === 'keys' && targetIsMap
    // 调用原型上的对应迭代器方法
    const innerIterator = target[method](...args)
    // 获取不同模式下的响应式转化方法
    const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
    //非只读模式下，依赖收集
    !isReadonly &&
      track(
        rawTarget,
        TrackOpTypes.ITERATE,
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
      )
    // return a wrapped iterator which returns observed versions of the
    // values emitted from the real iterator
    // 给返回的innerIterator插装，将其value值转为响应式数据
    return {
      // iterator protocol
      next() {
        const { value, done } = innerIterator.next()
        return done // 为done的时候，value是最后一个值的next，是undefined，没必要做响应式转换了
          ? { value, done }
          : {
              value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
              done
            }
      },
      // iterable protocol
      [Symbol.iterator]() {
        return this
      }
    }
  }
}

function createReadonlyMethod(type: TriggerOpTypes): Function {
  return function(this: CollectionTypes, ...args: unknown[]) {
    if (__DEV__) {
      const key = args[0] ? `on key "${args[0]}" ` : ``
      console.warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        toRaw(this)
      )
    }
    return type === TriggerOpTypes.DELETE ? false : this
  }
}

//可变集合handler中的插装对象（属性为复写集合的内置方法，也称为 “插装方法”）
const mutableInstrumentations: Record<string, Function> = {
  //插装方法
  get(this: MapTypes, key: unknown) {
    return get(this, key)
  },
  get size() {
    return size((this as unknown) as IterableCollections)
  },
  has,
  add,
  set,
  delete: deleteEntry,
  clear,
  forEach: createForEach(false, false)
}

//浅模式下需要监听的集合方法调用
const shallowInstrumentations: Record<string, Function> = {
  get(this: MapTypes, key: unknown) {
    return get(this, key, false, true)
  },
  get size() {
    return size((this as unknown) as IterableCollections)
  },
  has,
  add,
  set,
  delete: deleteEntry,
  clear,
  forEach: createForEach(false, true)
}
//只读模式下需要监听的集合方法调用
const readonlyInstrumentations: Record<string, Function> = {
  get(this: MapTypes, key: unknown) {
    return get(this, key, true)
  },
  get size() {
    return size((this as unknown) as IterableCollections, true)
  },
  has(this: MapTypes, key: unknown) {
    return has.call(this, key, true)
  },
  add: createReadonlyMethod(TriggerOpTypes.ADD),
  set: createReadonlyMethod(TriggerOpTypes.SET),
  delete: createReadonlyMethod(TriggerOpTypes.DELETE),
  clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
  forEach: createForEach(true, false)
}
//集合的迭代器相关方法
const iteratorMethods = ['keys', 'values', 'entries', Symbol.iterator]
iteratorMethods.forEach(method => {
  mutableInstrumentations[method as string] = createIterableMethod(
    method,
    false,
    false
  )
  readonlyInstrumentations[method as string] = createIterableMethod(
    method,
    true,
    false
  )
  shallowInstrumentations[method as string] = createIterableMethod(
    method,
    false,
    true
  )
})
//创建不同模式下的 getter 捕获器方法
function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  //一个对象（称为插装对象），内部属性为复写的集合内置方法（会发现跟前面 baseHandlers 中的数组行为类似）
  const instrumentations = shallow
    ? shallowInstrumentations
    : isReadonly
      ? readonlyInstrumentations
      : mutableInstrumentations
  //返回的getter
  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes
  ) => {
    //如果key为 '__v_isReactive'则返回 !isReadonly，判断代理对象是否是可响应的
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
      //如果key为 '__v_isReadonly',则返回 isReadonly 状态的值,判断代理对象是否是只读的
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
      //如果 key 为 '__v_raw',并且 代理对象的 receiver 在 readonlyMap/reactiveMap 找的到
      //(说明是来获取proxy代理对象的rawObject的),
      //则返回代理对象对应的原始 target 集合对象
    } else if (key === ReactiveFlags.RAW) {
      return target
    }
    // 如果key是`get`、`has`、`add`、`set`、`delete`、`clear`、`forEach`，或者`size`，表示是调用集合的内置方法，则
    //将target 用 instrumentations 替代，否则表示是获取普通属性行为，目标对象还是target然后将获取结果返回（内置方法或者属性值）
    return Reflect.get(
      hasOwn(instrumentations, key) && key in target
        ? instrumentations
        : target,
      key,
      receiver
    )
  }
}

//可变集合的代理handler
//这里会发现跟之前的 baseHandlers 中定义的handler不一样，集合的 handler 只有一个 getter 捕获器方法，并没有发现 setter 等其他捕获方法，
//原因是对于集合(Map,Set,WeakMap,WeakSet，其实还有Date，Promise等这里不涉及，所以就不讨论)，它们内部都有一个 “internal slots”（内部插槽）,
//是用来存储属性数据的，这些属性数据在访问的时候可以被集合的内置方法直接访问（get,set,has等），而不通过[[Get]] / [[Set]]内部方法访问它们。因此代理无法拦截
//你可以尝试对集合的代理后对象直接使用 .get ,或者 .set 方式去操作，会报错：TypeError: Method Map.prototype.set/get called on incompatible receiver [object Object]
//那换做代理对象，因为代理对象内部并没有 “internal slots” ，内置方法Map.prototype.set/get方法尝试访问内部属性this.[[MapData]]，但由于this = proxy，无法在代理中找到它,
//所以就会报错来表示访问属性失败。https://javascript.info/proxy#built-in-objects-internal-slots

export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  // get trap(捕获器)方法。
  get: createInstrumentationGetter(false, false) //isReadonly: false, shallow: false
}
//浅层模式集合代理handler
export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: createInstrumentationGetter(false, true)
}
//只读模式集合代理handler
export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: createInstrumentationGetter(true, false)
}

function checkIdentityKeys(
  target: CollectionTypes,
  has: (key: unknown) => boolean,
  key: unknown
) {
  const rawKey = toRaw(key)
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target)
    console.warn(
      `Reactive ${type} contains both the raw and reactive ` +
        `versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
        `which can lead to inconsistencies. ` +
        `Avoid differentiating between the raw and reactive versions ` +
        `of an object and only use the reactive version if possible.`
    )
  }
}
