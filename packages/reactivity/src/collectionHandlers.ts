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

const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value

const toReadonly = <T extends unknown>(value: T): T =>
  isObject(value) ? readonly(value as Record<any, any>) : value

const toShallow = <T extends unknown>(value: T): T => value

const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

//插装方法 get,访问集合 internal slots(内置插槽) 中存放的属性
//Map,WeakMap
function get(
  target: MapTypes,//这里需要注意 target 目标对象不是 原始集合对象，而是 它的代理对象
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

function has(this: CollectionTypes, key: unknown, isReadonly = false): boolean {
  const target = (this as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  const rawKey = toRaw(key)
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
  target = (target as any)[ReactiveFlags.RAW]
  !isReadonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
  return Reflect.get(target, 'size', target)
}
//插装方法 add,往集合 internal slots(内置插槽) 中存属性值
//set ,MapSet
function add(this: SetTypes, value: unknown) {
  value = toRaw(value)
  const target = toRaw(this)
  const proto = getProto(target)
  const hadKey = proto.has.call(target, value)
  const result = target.add(value)
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, value, value)
  }
  return result
}

function set(this: MapTypes, key: unknown, value: unknown) {
  value = toRaw(value)
  const target = toRaw(this)
  const { has, get } = getProto(target)

  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  const oldValue = get.call(target, key)
  const result = target.set(key, value)
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, key, value)
  } else if (hasChanged(value, oldValue)) {
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  return result
}

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

  const oldValue = get ? get.call(target, key) : undefined
  // forward the operation before queueing reactions
  const result = target.delete(key)
  if (hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

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

function createForEach(isReadonly: boolean, isShallow: boolean) {
  return function forEach(
    this: IterableCollections,
    callback: Function,
    thisArg?: unknown
  ) {
    const observed = this as any
    const target = observed[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
    !isReadonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)
    return target.forEach((value: unknown, key: unknown) => {
      // important: make sure the callback is
      // 1. invoked with the reactive map as `this` and 3rd arg
      // 2. the value received should be a corresponding reactive/readonly.
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

function createIterableMethod(
  method: string | symbol,
  isReadonly: boolean,
  isShallow: boolean
) {
  return function(
    this: IterableCollections,
    ...args: unknown[]
  ): Iterable & Iterator {
    const target = (this as any)[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    const targetIsMap = isMap(rawTarget)
    const isPair =
      method === 'entries' || (method === Symbol.iterator && targetIsMap)
    const isKeyOnly = method === 'keys' && targetIsMap
    const innerIterator = target[method](...args)
    const wrap = isReadonly ? toReadonly : isShallow ? toShallow : toReactive
    !isReadonly &&
      track(
        rawTarget,
        TrackOpTypes.ITERATE,
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
      )
    // return a wrapped iterator which returns observed versions of the
    // values emitted from the real iterator
    return {
      // iterator protocol
      next() {
        const { value, done } = innerIterator.next()
        return done
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
//集合的迭代方法调用
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

export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: createInstrumentationGetter(false, true)
}

export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: createInstrumentationGetter(true, false)
}

//检测集合中是否已经存在相同key
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
