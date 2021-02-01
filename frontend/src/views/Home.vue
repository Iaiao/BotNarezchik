<template>
  <div class="home" id="title-block">
      <div>
        <h3>Бот Нарезчик</h3>
        <b-form-input style="display:inline-block;" v-model="text" placeholder="ID поста"></b-form-input>
        <b-button v-b-modal.modal-1>Нарезать</b-button>
      </div>
        
          <select-component v-bind:text="text"></select-component>

  </div>
</template>
<style scoped>
  #title-block {
    width:100vw; height: 100vh; 
    max-width: 100%; max-height: 100%;
    display:flex; 
    justify-content: center; 
    align-items: center;
  }
</style>
<script>
import SelectComponent from './SelectComponent.vue'


export default {
  name: 'Home',
  components: {
    SelectComponent
  },
  data(){
    return {
      text: ""
    }
  }
}
</script>
