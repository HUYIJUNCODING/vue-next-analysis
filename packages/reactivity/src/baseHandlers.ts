//引入 reactive 文件中的一些方法和类型变量
import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap
} from './reactive'
//操作数据的行为枚举常量
import { TrackOpTypes, TriggerOpTypes } from './operations'
//引入effect 文件中的一些方法和变量标识
import {
  track, //依赖收集的方法
  trigger, //触发依赖更新的方法
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
//一些工具函数
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend
} from '@vue/shared'
//判断是否是一个 Ref 类型的方法
import { isRef } from './ref'

//Symbol 对象中的类型为 symbol 的 内置方法 集合
const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

//定义不同模式下的 getter
const get = /*#__PURE__*/ createGetter() //isReadonly = false, shallow = false
const shallowGet = /*#__PURE__*/ createGetter(false, true) //isReadonly = false, shallow = true
const readonlyGet = /*#__PURE__*/ createGetter(true) //isReadonly = true, shallow = false
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true) //isReadonly = true, shallow = true

const arrayInstrumentations: Record<string, Function> = {}
// instrument identity-sensitive Array methods to account for possible reactive
// values
;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
  const method = Array.prototype[key] as any
  arrayInstrumentations[key] = function(this: unknown[], ...args: unknown[]) {
    const arr = toRaw(this)
    for (let i = 0, l = this.length; i < l; i++) {
      track(arr, TrackOpTypes.GET, i + '')
    }
    // we run the method using the original args first (which may be reactive)
    const res = method.apply(arr, args)
    if (res === -1 || res === false) {
      // if that didn't work, run it again using raw values.
      return method.apply(arr, args.map(toRaw))
    } else {
      return res
    }
  }
})
// instrument length-altering mutation methods to avoid length being tracked
// which leads to infinite loops in some cases (#2137)
;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
  const method = Array.prototype[key] as any
  arrayInstrumentations[key] = function(this: unknown[], ...args: unknown[]) {
    pauseTracking()
    const res = method.apply(this, args)
    resetTracking()
    return res
  }
})

//handler中的 get trap(陷阱)，通过createGetter函数返回
function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    //receiver:最初被调用的对象,通常是 proxy 本身
    //如果key为 '__v_isReactive'则返回 !isReadonly，判断代理对象是否是可响应的 (这里很有意思，不是直接返回true/false，而是借助isReadonly这个状态模式取反，很巧妙，同时也直观的
    //反映只读类型的代理不是响应式的)
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
      //如果key为 '__v_isReadonly',则返回 isReadonly 状态的值,判断代理对象是否是只读的
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
      //如果 key 为 '__v_raw',并且 代理对象的 receiver 在 readonlyMap/reactiveMap 找的到
      //(说明是来获取proxy代理对象的rawObject的),
      //则返回代理对象对应的原始 target 对象(普通对象)
    } else if (
      key === ReactiveFlags.RAW &&
      receiver === (isReadonly ? readonlyMap : reactiveMap).get(target)
    ) {
      return target
    }

    //如果目标对象是数组,key是数组的内置方法名('includes', 'indexOf', 'lastIndexOf','push', 'pop', 'shift', 'unshift', 'splice')
    //并且当前key 在arrayInstrumentations 中找得到，那么返回arrayInstrumentations中key对应的方法
    const targetIsArray = isArray(target)
    if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
      //arrayInstrumentations 是一个对象，这个对象里面重写了与以上几个数组内置方法同名的方法
      return Reflect.get(arrayInstrumentations, key, receiver)
    }
    //采用反射的方式 获取原始对象身上某个属性值，类似于 target[name]。
    const res = Reflect.get(target, key, receiver)
    // 如果是 获取 Symbol 对象中的类型为 symbol 的 内置方法 或者是获取原型对象，或者是获取ref对象上的 __v_isRef 属性的值，
    //都直接返回 获取到的属性值，而不去执行依赖收集。我的理解是这些都是没有必要进行依赖收集的，因为它们基本都是不可变的，只有可变的属性才有必须
    //去收集，因为当他们的值改变了，对应的依赖也要去更新
    if (
      isSymbol(key)
        ? builtInSymbols.has(key as symbol)
        : key === `__proto__` || key === `__v_isRef`
    ) {
      return res
    }
    //非只读模式，调用 track 去收集依赖
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }
    //浅层模式直接返回反射获取的原始对象属性值，无论是否是对象类型，都不去进行深度追踪
    if (shallow) {
      return res
    }

    //只有ref作为对象属性，才会解套ref，返回ref.value ，否则不能解套会返回ref对象，
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      //ref 解套不能应用于key为integer（整数）类型的数组，所以官方文档会说
      //当嵌套在 reactive Object 中时，ref 才会解套。从 Array 或者 Map 等原生集合类中访问 ref 时，不会自动解套
      //集合的handler在collectionHandlers中，因此这里只看到了为数组的情况
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      return shouldUnwrap ? res.value : res
    }

    //如果获取到的属性值为object类型,则进一步进行响应式化处理(深度追踪)
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      //将返回值也转换为代理。进行isObject检查是为了是为了避免无效值警告。在这里惰性访问 readonly 和reactive 方法来将返回值进一步进行proxy 转换
      //以避免循环依赖的发生，其实将对象类型的属性值推迟到在这里去响应式转换，除了避免循环依赖，还可以提高性能，用的时候才去转嘛。
      return isReadonly ? readonly(res) : reactive(res)
    }
    return res
  }
}

//定义不同模式下的 setter
const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

//handler中的 set trap(陷阱)，通过createSetter函数返回
function createSetter(shallow = false) {
  return function set(
    target: object, //原始对象
    key: string | symbol, //key
    value: unknown, //新属性值
    receiver: object //最初被调用的对象,通常是 proxy 本身(为啥是通常而不是一定呢，可以看这里 https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/set#%E5%8F%82%E6%95%B0)
  ): boolean {
    //旧属性值
    const oldValue = (target as any)[key]
    //对于ref类型属性赋值只有非浅层模式下才去关心，否则不用去管
    if (!shallow) {
      //如果value是响应式数据，则返回其映射的原始数据
      value = toRaw(value)
      //如果原始对象不是数组,旧属性值是ref对象，新属性值不是ref对象，则将新值赋给旧属性的value，
      //这里也再次间接的说明嵌套在原始数组中的ref是无法解套的
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        //这里会直接return true，表示修改成功，而不让继续往下执行，去触发依赖更新，原因是这个过程会在ref中的set里面触发，因此这里就不用了
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
      //在浅层模式下，对象都按原样设置属性,不去管是否是响应式，
    }

    //判断key值是否存在(原始对象或者原始数组中)
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    // 将本次设置/修改行为，反射到原始对象上(返回值为布尔类型，true表示设置成功)
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    //如果操作的是原型链上的数据,则不做任何触发监听函数的行为。
    //receiver: 最初被调用的对象。通常是 proxy 本身，但 handler 的 set 方法也有可能在原型链上，或以其他方式被间接地调用（因此不一定是 proxy 本身）
    //所以，这里需要通过 target === toRaw(receiver) 就可以判断是否操作的是原型链上的数据。https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/set#%E5%8F%82%E6%95%B0
    //如果此时的赋值操作操作的是原型对象的属性，那就不用去触发依赖更新，首先因为目标对象上没有这个属性，才去的原型链上找，其次 receiver是目标对象，而不是原型对象
    //所以，设置行为还是发生在子对象（目标对象）身上的，原型对象其实没有变化，也就没有必须要触发依赖更新，如果不判断会发现set被触发两次，进而原型上的也会
    //进行一次依赖更新操作，目标对象也会进行一次。
    if (target === toRaw(receiver)) {
      //key如果不存在，则表示是添加属性
      // 否则是给旧属性设置新值
      // trigger 用于通知deps，通知依赖更新(触发依赖更新)
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}
//删除属性的trap方法
function deleteProperty(target: object, key: string | symbol): boolean {
  //判断目标对象上是否有这个key
  const hadKey = hasOwn(target, key)
  //获取旧的属性值
  const oldValue = (target as any)[key]
  //删除属性操作反射到原始对象上，结果为布尔值，表示执行删除结果
  const result = Reflect.deleteProperty(target, key)
  //如果删除成功，并且key存在，则去触发依赖更新
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  //返回执行删除的结果
  return result
}
//拦截 in 操作符，如果使用 in 操作符操作代理对象（例如： 'a' in p），则该 trap 方法会被触发
function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}
//拦截 Object.keys 方法
function ownKeys(target: object): (string | number | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

//可变普通对象的代理handler
export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

//只读模式下代理handler
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet, //readonlyGet 方法会返回getter ，readonlyGet会传递入参true给 getter 的形参isReadonly，标识只读模式，这样，getter 里面会根据此标识惰性访问 readonly将对象类型的属性值
  //用readonly 方法深度处理

  //只读模式不允许设置/修改原始对象的属性值
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  //也不允许删除属性值
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

//浅层模式下的代理handler
//extend 内部调用 Object.assign ，扩展合并对象属性的，会发现该模式下将 mutableHandlers 中的 get ，set 进行了重写，
//其余 trap跟mutableHandlers相同，那为啥要重写这两个trap方法呢，因为模式不一样，劫持逻辑肯定就不一样了，shollow模式下，只会对
//对象根层（第一层）属性进行劫持，因此是可变对象的浅化版（没有解套ref和深层追踪）
export const shallowReactiveHandlers: ProxyHandler<object> = extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
// 浅层只读模式下的代理handler
//只为某个对象的自有（第一层）属性创建浅层的只读响应式代理，同样也不会做深层次、递归地代理，深层次的属性并不是只读的
export const shallowReadonlyHandlers: ProxyHandler<object> = extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
